// Tells a shell command that only reads from one that may change files. A command reads only
// when every program it runs is a known reader, used in a reading way. Anything the parser
// cannot follow (backquotes, a heredoc, an open quote, arithmetic, a method call) is a write.
// A command substitution counts as reading only when the command inside it does.

export type Shell = 'bash' | 'pwsh'

// `dynamic` marks a word the shell may turn into other text: a variable, a substitution, a glob
// or a brace list. `bare` marks one it may also split into several words (an unquoted
// expansion). `raw` is the word with its quoted characters blanked to \0.
// `piped` marks a command that takes the output of the one before it through |.
type Command = { words: string[]; quoted: boolean[]; dynamic: boolean[]; bare: boolean[]; raw: string[]; piped: boolean }

// A brace list, a glob that may expand to a name starting with a dash (a [ globs only when a ]
// closes it, so [ and [[ stay commands), or a tilde (~- is $OLDPWD, ~+ is $PWD, at the start
// of a word or of an assignment's value).
const bashExpands = (raw: string, word: string) =>
  /\{[^}]*(,|\.\.)[^}]*\}/.test(raw) ||
  /(^|[=:])~/.test(raw) ||
  (/[*?]|\[.*\]/.test(raw) && (/^([*?]|\[.*\])/.test(raw) || word.startsWith('-')))

// Words that only open shell grammar; the command they guard follows. Quoted, they are
// ordinary words: '!' or "if" runs a command of that name. ! and time open a pipeline only, so
// after a | they are commands too.
const GRAMMAR = /^(then|do|else|elif|if|while|until|time|!|\{)$/
const grammar = (word: string, quoted: boolean | undefined, piped = false) =>
  !quoted && GRAMMAR.test(word) && !(piped && (word === '!' || word === 'time'))

// Collects words into commands; `undefined` from a reader below means "runs code we cannot see".
const collector = (shell: Shell) => {
  const out: Command[] = []
  const fresh = (piped = false): Command => ({ words: [], quoted: [], dynamic: [], bare: [], raw: [], piped })
  let cmd = fresh()
  const at = { word: '', raw: '', open: false, quoted: false, dynamic: false, bare: false }
  const endWord = () => {
    if (at.open) {
      const expands = shell === 'bash' && bashExpands(at.raw, at.word)
      cmd.words.push(at.word)
      cmd.raw.push(at.raw)
      cmd.quoted.push(at.quoted)
      cmd.dynamic.push(at.dynamic || expands)
      cmd.bare.push(at.bare || expands)
    }
    Object.assign(at, { word: '', raw: '', open: false, quoted: false, dynamic: false, bare: false })
  }
  const endCommand = (piped = false) => {
    endWord()
    if (cmd.words.length) out.push(cmd)
    cmd = fresh(piped)
  }
  const add = (text: string, isQuoted = false, isDynamic = false) => {
    at.word += text
    at.raw += isQuoted ? '\0'.repeat(text.length) : text
    at.open = true
    at.quoted ||= isQuoted
    at.dynamic ||= isDynamic
    at.bare ||= isDynamic && !isQuoted
  }
  // A number just before `>` or `<` is the redirect's descriptor, not a word: in bash one that
  // fits an int (a longer one is an argument), in PowerShell a stream number or *.
  const dropDescriptor = () => {
    const descriptor = shell === 'bash' ? /^\d+$/.test(at.word) && Number(at.word) <= 2147483647 : /^[1-6*]$/.test(at.word)
    if (at.open && !at.quoted && !at.dynamic && descriptor) Object.assign(at, { word: '', raw: '', open: false })
  }
  const isEmpty = () => cmd.words.length === 0 && !at.open
  // Inside [[ ]], && || ( ) < > and newlines are its own operators, not the shell's.
  const inTest = () => {
    const words = at.open ? [...cmd.words, at.word] : cmd.words
    const quoted = at.open ? [...cmd.quoted, at.quoted] : cmd.quoted
    const k = words.findIndex((w, i) => !grammar(w, quoted[i], cmd.piped))
    return k >= 0 && words[k] === '[[' && !quoted[k] && !words.some((w, i) => i > k && w === ']]' && !quoted[i])
  }
  return { out, at, endWord, endCommand, add, dropDescriptor, isEmpty, inTest }
}

// The word a redirect names, from `i`: its text, the index of its last character (-1 when it
// hides code or expands into something else), and whether any of it was quoted. bash expands
// that word in full, arithmetic included, so only a plain $name may stand in it.
const target = (s: string, from: number, shell: Shell): [string, number, boolean] => {
  let i = from
  while (s[i] === ' ' || s[i] === '\t') i++
  let t = ''
  let quoted = false
  const stop = shell === 'bash' ? /[\s;&|()<>]/ : /[\s;&|()<>{}]/
  for (; i < s.length && !stop.test(s[i]!); i++) {
    const c = s[i]!
    if (c === "'") {
      const j = s.indexOf(c, i + 1)
      // PowerShell doubles a quote inside one: not followed here.
      if (j < 0 || (shell === 'pwsh' && s[j + 1] === "'")) return ['', -1, true]
      t += s.slice(i + 1, j)
      quoted = true
      i = j
    } else if (c === '"') {
      // Read as the shell does: escapes skip the next character, and an expansion may run code.
      const escape = shell === 'bash' ? '\\' : '`'
      let j = i + 1
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === escape) t += s[++j] ?? ''
        else if (s[j] === '`' || (s[j] === '$' && /[({[]/.test(s[j + 1] ?? ''))) return ['', -1, true]
        else t += s[j]
      }
      if (j >= s.length || (shell === 'pwsh' && s[j + 1] === '"')) return ['', -1, true]
      quoted = true
      i = j
    } else if (c === '`' && shell === 'bash') return ['', -1, quoted]
    else if (c === '$' && shell === 'bash' && /[({[]/.test(s[i + 1] ?? '')) return ['', -1, quoted]
    else if (c === '\\' && shell === 'bash') t += s[++i] ?? ''
    else t += c
  }
  return [t, i - 1, quoted]
}

// The target of >& or <&: another descriptor (2>&1, >&-) or, for >&, a file. -1 for a file.
const duplicate = (s: string, from: number, shell: Shell): number => {
  const [name, end] = target(s, from, shell)
  return end >= 0 && /^(\d+-?|-)$/.test(name) ? end : -1
}

// After `>` at index i: the index the redirect ends at, or -1 when it writes a file. In
// PowerShell '$null' in quotes is a file of that name.
const redirect = (s: string, i: number, shell: Shell): number => {
  let j = i + 1
  if (s[j] === '>' || s[j] === '|') j++
  if (s[j] === '&') return duplicate(s, j + 1, shell)
  const [name, end, quoted] = target(s, j, shell)
  if (end < 0) return -1
  const nowhere = shell === 'bash' ? name === '/dev/null' : !quoted && /^(\$null|nul)$/i.test(name)
  return nowhere ? end : -1
}

// From just inside `$(` or `<(`: the index of the `)` that closes it, or -1. It skips what bash
// skips there (quotes, escapes) and nests; a comment inside is refused rather than followed.
const closeParen = (s: string, from: number): number => {
  let depth = 1
  for (let k = from; k < s.length; k++) {
    const ch = s[k]!
    if (ch === '\\') k++
    else if (ch === '$' && s[k + 1] === "'") {
      for (k += 2; k < s.length && s[k] !== "'"; k++) if (s[k] === '\\') k++
      if (k >= s.length) return -1
    } else if (ch === "'") {
      k = s.indexOf("'", k + 1)
      if (k < 0) return -1
    } else if (ch === '"') {
      for (k++; k < s.length && s[k] !== '"'; k++) {
        if (s[k] === '\\') k++
        else if (s[k] === '`') return -1
        else if (s[k] === '$' && s[k + 1] === '(') {
          k = closeParen(s, k + 2)
          if (k < 0) return -1
        }
      }
      if (k >= s.length) return -1
    } else if (ch === '`') return -1
    else if (ch === '#' && s[k - 1] !== '$' && s[k - 1] !== '{') return -1
    else if (ch === '(') depth++
    else if (ch === ')' && --depth === 0) return k
  }
  return -1
}

// A substitution's command, from just inside its `(`: the index of its `)`, or -1 when the
// command may write, cannot be followed, or is arithmetic.
const substitution = (s: string, from: number): number => {
  if (s[from] === '(') return -1
  const end = closeParen(s, from)
  return end < 0 || mayWrite(s.slice(from, end), 'bash') ? -1 : end
}

// ${...} forms that only read a variable: no subscript but [@] or [*], no offset (arithmetic),
// no indirection (${!x}), no assignment (${x:=y}), no nested quotes or substitutions.
const PARAM = /^#?([A-Za-z_]\w*(\[[@*]\])?|\d+|[@*#?$!-])((:?[-+?]|##?|%%?|\/[\/#%]?|\^\^?|,,?)([^{}'"`\\[\]$<>()]|\$[A-Za-z_]\w*)*)?$/
// From the $ of `${`: the index of its }, or -1.
const parameter = (s: string, at: number): number => {
  const end = s.indexOf('}', at + 2)
  return end > 0 && PARAM.test(s.slice(at + 2, end)) ? end : -1
}

// A `$` that starts an expansion rather than standing for itself.
const expands = (next: string | undefined) => /[\w@*#?$!\-]/.test(next ?? '')

const bashCommands = (s: string): Command[] | undefined => {
  const c = collector('bash')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    const next = s[i + 1]
    // Inside [[ ]], these are its operators: keep them as words. <( and >( still substitute.
    if ('&|()<>\n'.includes(ch) && !((ch === '<' || ch === '>') && next === '(') && c.inTest()) {
      c.endWord()
      if (ch !== '\n') {
        const pair = (ch === '&' || ch === '|') && next === ch
        c.add(pair ? ch + ch : ch)
        c.endWord()
        if (pair) i++
      }
      continue
    }
    if (ch === '\\') {
      if (next !== '\n') c.add(next ?? '', true)
      i++
    } else if (ch === "'") {
      const j = s.indexOf("'", i + 1)
      if (j < 0) return undefined
      c.add(s.slice(i + 1, j), true)
      i = j
    } else if (ch === '$' && next === "'") {
      // Its escapes (\x2d is a dash) make text the words here do not show.
      let j = i + 2
      for (; j < s.length && s[j] !== "'"; j++) if (s[j] === '\\') j++
      if (j >= s.length) return undefined
      const text = s.slice(i + 2, j)
      c.add(text, true, text.includes('\\'))
      i = j
    } else if (ch === '"' || (ch === '$' && next === '"')) {
      // A $"..." string is translated, so it may become other text.
      let j = ch === '$' ? i + 2 : i + 1
      let text = ''
      let dynamic = ch === '$'
      for (; j < s.length && s[j] !== '"'; j++) {
        const d = s[j]!
        if (d === '`') return undefined
        if (d === '\\') {
          if (/[$`"\\\n]/.test(s[j + 1] ?? '')) {
            j++
            if (s[j] !== '\n') text += s[j]
          } else text += d
        } else if (d === '$' && s[j + 1] === '(') {
          j = substitution(s, j + 2)
          if (j < 0) return undefined
          dynamic = true
        } else if (d === '$' && s[j + 1] === '{') {
          j = parameter(s, j)
          if (j < 0) return undefined
          dynamic = true
        } else if (d === '$' && s[j + 1] === '[') {
          return undefined
        } else {
          if (d === '$' && expands(s[j + 1])) dynamic = true
          text += d
        }
      }
      if (j >= s.length) return undefined
      c.add(text, true, dynamic)
      i = j
    } else if ((ch === '$' || ch === '<') && next === '(') {
      // A substitution, or a process substitution read as a file: a word we cannot see.
      i = substitution(s, i + 2)
      if (i < 0) return undefined
      c.add('', false, true)
    } else if (ch === '$' && next === '{') {
      i = parameter(s, i)
      if (i < 0) return undefined
      c.add('', false, true)
    } else if (ch === '`' || (ch === '>' && next === '(') || (ch === '$' && next === '[')) {
      return undefined
    } else if (ch === '$') {
      c.add(ch, false, expands(next))
    } else if (ch === '#' && !c.at.open) {
      while (i + 1 < s.length && s[i + 1] !== '\n') i++
    } else if (ch === ' ' || ch === '\t') {
      c.endWord()
    } else if (ch === '(' && next === '(') {
      return undefined // (( )) and for (( )) evaluate arithmetic
    } else if (ch === '(' && c.at.open && /=$/.test(c.at.raw)) {
      return undefined // x=( ) assigns an array, its [subscripts] as arithmetic
    } else if (ch === '\n' || ch === ';' || ch === '(' || ch === ')') {
      c.endCommand()
    } else if (ch === '|') {
      c.endCommand(next !== '|')
      if (next === '|' || next === '&') i++
    } else if (ch === '&' && next === '>') {
      c.endWord()
      // A redirect before the command's first word makes [[, if and the like plain words.
      if (c.isEmpty()) return undefined
      i = redirect(s, i + 1, 'bash')
      if (i < 0) return undefined
    } else if (ch === '&') {
      c.endCommand()
      if (next === '&') i++
    } else if ((ch === '>' || ch === '<') && c.at.open && /^\{.*\}$/.test(c.at.raw)) {
      return undefined // {name}> stores a descriptor in name, and a[x] there is arithmetic
    } else if (ch === '>') {
      c.dropDescriptor()
      c.endWord()
      if (c.isEmpty()) return undefined
      i = redirect(s, i, 'bash')
      if (i < 0) return undefined
    } else if (ch === '<') {
      c.dropDescriptor()
      c.endWord()
      if (c.isEmpty()) return undefined
      if (next === '>') return undefined // opens the file for writing too
      if (next === '<' && s[i + 2] !== '<') return undefined // a heredoc
      if (next === '&') {
        i = duplicate(s, i + 2, 'bash')
        if (i < 0) return undefined
        continue
      }
      // An input file, or a here-string's text: read, never run.
      const [, end] = target(s, next === '<' ? i + 3 : i + 1, 'bash')
      if (end < 0) return undefined
      i = end
    } else {
      // A carriage return too: bash takes it as part of a word, not as a blank.
      c.add(ch)
    }
  }
  c.endCommand()
  return c.out
}

// PowerShell reads typographic quotes as quotes, en and em dashes as dashes, a lone carriage
// return as a newline, and every Unicode separator as a blank.
const pwshNormal = (s: string) =>
  s
    .replace(/\r\n?/g, '\n')
    .replace(/[‘-‛]/g, "'")
    .replace(/[“-„]/g, '"')
    .replace(/[–-―]/g, '-')
    .replace(/[\f\v\u0085\p{Z}]/gu, ' ')

// The words a ( may follow: $( and @( open a sub-expression, a keyword or an operator opens a
// group. After anything else, ( calls a method: $f.Delete(), .'Delete'(), [IO.File]::Delete().
const PS_OPENS = /^(\$|@|[!,=+\-*/%]+|.*[=,]|-[A-Za-z]+|\[[\w.\[\], ]+\]|if|elseif|while|for|foreach|switch|until|catch|param|do|return|throw|exit)$/i

const pwshCommands = (input: string): Command[] | undefined => {
  const s = pwshNormal(input)
  const c = collector('pwsh')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    const next = s[i + 1]
    if (ch === '`') {
      if (next !== '\n') c.add(next ?? '', true)
      i++
    } else if (ch === "'") {
      let j = i + 1
      let text = ''
      for (; j < s.length; j++) {
        if (s[j] === "'") {
          if (s[j + 1] !== "'") break
          j++
        }
        text += s[j]
      }
      if (j >= s.length) return undefined
      c.add(text, true)
      i = j
    } else if (ch === '"') {
      let j = i + 1
      let text = ''
      let dynamic = false
      for (; j < s.length; j++) {
        if (s[j] === '`') {
          text += s[++j] ?? ''
          continue
        }
        if (s[j] === '$' && s[j + 1] === '(') return undefined
        if (s[j] === '$') dynamic = true
        if (s[j] === '"') {
          if (s[j + 1] !== '"') break
          j++
        }
        text += s[j]
      }
      if (j >= s.length) return undefined
      c.add(text, true, dynamic)
      i = j
    } else if (ch === '@' && (next === "'" || next === '"') && c.at.open) {
      return undefined // a here-string opens even glued to a word: 1,@'
    } else if (ch === '@' && (next === "'" || next === '"')) {
      // A here-string: its text runs to a line that starts with the quote and @.
      const end = s.indexOf(`\n${next}@`, i + 2)
      if (end < 0) return undefined
      const text = s.slice(i + 2, end)
      if (next === '"' && /\$\(/.test(text)) return undefined
      c.add(text, true, next === '"' && text.includes('$'))
      i = end + 2
    } else if (ch === '<' && next === '#') {
      const end = s.indexOf('#>', i + 2)
      if (end < 0) return undefined
      i = end + 1
    } else if (ch === '#' && !c.at.open) {
      while (i + 1 < s.length && s[i + 1] !== '\n') i++
    } else if (ch === ' ' || ch === '\t') {
      c.endWord()
    } else if (ch === '(') {
      if (c.at.open && !PS_OPENS.test(c.at.word)) return undefined
      if (c.at.open && (c.at.word === '$' || c.at.word === '@')) Object.assign(c.at, { word: '', raw: '', open: false, dynamic: false, bare: false })
      // Its output is an argument of the command it sits in, whose text we cannot see.
      if (!c.isEmpty()) {
        c.endWord()
        c.add('', false, true)
      }
      c.endCommand()
    } else if (ch === '\n' || ch === ';' || ch === ')' || ch === '{' || ch === '}') {
      c.endCommand()
    } else if (ch === '|') {
      c.endCommand(next !== '|')
      if (next === '|') i++
    } else if (ch === '&') {
      // && chains; a lone & calls whatever follows it, or runs the line as a background job.
      if (next !== '&') return undefined
      c.endCommand()
      i++
    } else if (ch === '>') {
      c.dropDescriptor()
      c.endWord()
      i = redirect(s, i, 'pwsh')
      if (i < 0) return undefined
    } else if (ch === '<') {
      return undefined
    } else {
      // A variable, or @name splatting a list of arguments.
      c.add(ch, false, ch === '$' || (ch === '@' && !c.at.open && /\w/.test(next ?? '')))
    }
  }
  c.endCommand()
  return c.out
}

type Rule = true | ((args: string[], dynamic: boolean[], bare: boolean[]) => boolean)

// A check that reads the arguments holds only for arguments the shell passes on as written.
const literal =
  (check: (args: string[]) => boolean) =>
  (args: string[], dynamic: boolean[]) =>
    !dynamic.some(Boolean) && check(args)

// A long option the program would take as an abbreviation of one of `names` (getopt_long and
// git's parse-options both accept a unique prefix).
const abbreviates = (arg: string, names: string[]) => {
  const name = arg.split('=')[0]!
  return name.startsWith('--') && name.length >= 3 && names.some(n => n.startsWith(name))
}

// Variables a command may be run with without changing what it does to files.
const SAFE_ENV = /^(LANG|LANGUAGE|LC_\w+|NO_COLOR|FORCE_COLOR|CLICOLOR\w*|TERM|TZ|CI|COLUMNS|LINES)$/
const safeAssignments = (args: string[]) =>
  args.every(a => !/^[A-Za-z_]\w*=/.test(a) || SAFE_ENV.test(a.slice(0, a.indexOf('='))))

// Variables the shell itself acts on (PS4 runs code under set -x, IFS splits words, RANDOM and
// the other integers evaluate what is assigned, OLDPWD and PWD are what ~- and ~+ give), and
// those a reader takes its config or a command from, if they are already exported.
const SPECIAL_VARS =
  /^(RANDOM|SRANDOM|SECONDS|LINENO|EPOCH\w*|EUID|UID|PPID|OLDPWD|PWD|DIRSTACK|GROUPS|FUNCNAME|BASH\w*|SHELLOPTS|ENV|IFS|PATH|CDPATH|GLOBIGNORE|GLOBSORT|EXECIGNORE|FIGNORE|FUNCNEST|HIST\w*|HOME|PS\d|PROMPT_\w+|TIMEFORMAT|TMOUT|TMPDIR|TEMP|TMP|POSIXLY_CORRECT|SHELL|OPT\w+|MAIL\w*|INPUTRC|COMP\w*|READLINE\w*|LD_\w+|DYLD_\w+|XDG_\w+|GIT_\w+|GH_\w+|\w*PAGER|LESS\w*|EDITOR|VISUAL|NODE_\w+|NPM_\w+|npm_\w+|PYTHON\w*|AWK\w*|RIPGREP\w*|GREP_\w+|GRAPHIFY\w*|auto_resume|histchars)$/
const ordinary = (assignment: string) => !SPECIAL_VARS.test(assignment.split('=')[0]!)

const nonOptions = (args: string[]) => args.filter(a => !a.startsWith('-') && !/^(\d+|0x[\da-f]+)$/i.test(a))

const GIT_READS = new Set(
  (
    'status log diff show rev-parse ls-files blame grep cat-file ls-tree describe shortlog rev-list merge-base ' +
    'for-each-ref show-ref check-ignore diff-tree name-rev count-objects help version'
  ).split(' '),
)

// Options of git's reads that write a file or run a command, as git takes their prefixes too.
const GIT_DANGER = ['--output', '--open-files-in-pager', '--ext-diff', '--textconv', '--upload-pack']

// Options that only choose what a listing shows, for branch and tag.
const LISTING = String.raw`-l|--list|-i|--ignore-case|--omit-empty|--no-column|--column(=[\w,]+)?|--(sort|format)=.*`

// git's own options before the subcommand. -c and --config-env set config that runs commands of
// its own choosing (core.pager, diff.external); others take the next word as their value, so
// the subcommand would be another word than it looks. Only these pass.
const GIT_GLOBAL_VALUE = /^(-C|--git-dir|--work-tree|--namespace)$/
const GIT_GLOBAL = /^(--(git-dir|work-tree|namespace)=.*|--no-pager|-P|--bare|--no-replace-objects|--no-optional-locks|--no-advice|--(literal|glob|noglob|icase)-pathspecs)$/

const gitReads = (args: string[]): boolean => {
  let i = 0
  for (; i < args.length; i++) {
    const a = args[i]!
    if (GIT_GLOBAL_VALUE.test(a)) i++
    else if (!a.startsWith('-')) break
    else if (!GIT_GLOBAL.test(a)) return false
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  // -O opens matches in a pager it names, bundled or not: -iO'cmd'.
  if (rest.some(a => /^-[a-zA-Z]*O/.test(a) || abbreviates(a, GIT_DANGER))) return false
  // With --list, the names that follow are patterns to match, not branches or tags to make.
  const listed = rest.some(a => a === '-l' || a === '--list')
  switch (sub) {
    case 'branch':
      return rest.every(
        a =>
          new RegExp(`^(-a|-r|-v|-vv|--all|--remotes|--verbose|--show-current|--no-color|--color(=\\w+)?|${LISTING})$`).test(a) ||
          (listed && !a.startsWith('-')),
      )
    case 'tag':
      return rest.every(a => new RegExp(`^(-n\\d*|${LISTING})$`).test(a) || (listed && !a.startsWith('-')))
    case 'ls-remote':
      // A transport named with :: may run a command.
      return rest.every(
        a =>
          /^(-h|--heads|-t|--tags|-b|--branches|--refs|-q|--quiet|--exit-code|--get-url|--symref|--sort=.*)$/.test(a) ||
          (!a.startsWith('-') && !a.includes('::')),
      )
    case 'remote':
      return rest.every(a => /^(-v|--verbose)$/.test(a)) || /^(show|get-url)$/.test(rest[0] ?? '')
    case 'stash':
      return /^(list|show)$/.test(rest[0] ?? '')
    case 'config':
      // `git config get` and `list`, or an action option that reads. A bare `get` later on is a
      // value: `git config core.pager x get` sets core.pager.
      if (/^(get|list)$/.test(rest[0] ?? '')) return true
      return (
        rest.some(a => /^(--get(-all|-regexp|-urlmatch|-color|-colorbool)?|--list|-l)$/.test(a)) &&
        !rest.some(a => a === '-e' || abbreviates(a, ['--add', '--unset', '--unset-all', '--replace-all', '--rename-section', '--remove-section', '--edit']))
      )
    case 'worktree':
      return rest[0] === 'list'
    case 'reflog':
      // Show is the default; drop, expire, delete and write change the logs.
      return !rest.length || /^(show|list|exists)$/.test(rest[0]!) || /^(HEAD|refs\/|@)|[/@]/.test(rest[0]!) || rest[0]!.startsWith('-')
    default:
      return sub !== undefined && GIT_READS.has(sub)
  }
}

// gh api reads with GET alone: a field or an input file sends a body, and so changes something.
const GH_API_VALUE = /^(-q|--jq|-t|--template|-H|--header|--hostname|--cache|-p|--preview)$/
const ghApiReads = (args: string[]) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '-X' || a === '--method') {
      if (!/^(GET|HEAD)$/i.test(args[++i] ?? '')) return false
    } else if (/^(-X|--method=)/.test(a)) {
      if (!/^(-X|--method=)(GET|HEAD)$/i.test(a)) return false
    } else if (GH_API_VALUE.test(a)) i++
    else if (a.startsWith('-') && !/^(--(jq|template|header|hostname|cache|preview)=|-[qtHp].|--paginate$|--slurp$|-i$|--include$|--silent$|--verbose$)/.test(a)) {
      return false
    }
  }
  return true
}

// Past its subcommand, a gh read takes names and options that only shape what it prints.
const ghReads = (args: string[], dynamic: boolean[]) => {
  if (dynamic[0] || dynamic[1]) return false
  if (args[0] === 'api') return !dynamic.some(Boolean) && ghApiReads(args.slice(1))
  return (
    args[0] === 'status' ||
    (/^(pr|issue|run|repo|release|workflow|auth)$/.test(args[0] ?? '') && /^(view|list|diff|checks|status)$/.test(args[1] ?? ''))
  )
}

// npm's reads print what the registry or the installed tree holds, and run no package scripts.
const npmReads = (args: string[], dynamic: boolean[]) =>
  !dynamic[0] && /^(view|v|info|show|ls|list|la|ll|outdated|explain|why|search|s|find)$/.test(args[0] ?? '')

// graphify's queries read graph.json and print; build, update and the rest write it.
const graphifyReads = (args: string[]) =>
  /^(query|path|explain)$/.test(args[0] ?? '') &&
  args.slice(1).every(a => !a.startsWith('-') || /^--(dfs|context|budget|graph)(=|$)/.test(a))

// --pre runs a program on each file, --hostname-bin runs one to name the host.
const rgReads = (args: string[]) => !args.some(a => /^--(pre|hostname-bin)(=|$)/.test(a))

// sed reads when its script only prints, deletes from the output or substitutes, with no w or e.
const SED_OPTS = /^(-[nEsuzr]+|--(quiet|silent|regexp-extended|separate|unbuffered|null-data|posix|debug|sandbox))$/
const REGEX_ADDRESS = String.raw`\/(?:[^\\/\n]|\\.)*\/`
const ADDRESS = String.raw`((\d+|\$|${REGEX_ADDRESS})(,(\d+|\$|${REGEX_ADDRESS}))?)?`
const SED_LINE = new RegExp(`^${ADDRESS}[pdq=]?$`)
// The s delimiter may not be a backslash or a newline: s\t\t\e hides the e flag.
const SED_SUB = new RegExp(String.raw`^${ADDRESS}s([^\\\n])(?:(?!\5)[^\\]|\\.)*\5(?:(?!\5)[^\\]|\\.)*\5[gpiIm0-9]*$`)
const sedReads = (args: string[]) => {
  const scripts: string[] = []
  const files: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '-e' || a === '--expression') scripts.push(args[++i] ?? '')
    else if (a.startsWith('--expression=')) scripts.push(a.slice('--expression='.length))
    else if (a.startsWith('-') && a !== '-') {
      if (!SED_OPTS.test(a)) return false
    } else files.push(a)
  }
  if (!scripts.length) scripts.push(files[0] ?? '')
  return scripts.every(script =>
    script.split(/[;\n]/).every(part => SED_LINE.test(part.trim()) || SED_SUB.test(part.trim())),
  )
}

// An awk program reduced to the code awk runs: strings become "", comments go, a backslash
// before a newline joins the lines, and with `regex` set, a / that opens a regex literal skips
// to its end. As awk does, a / right after an operand (a name, a number, a string, a regex, a
// ] or a ) that is not an if, while or for condition, i++) divides, and anywhere else, keywords
// like print and exit included, opens a regex. Should that reading go wrong, the scan without
// regexes still shows the code. undefined when it cannot tell where a string or regex ends.
const AWK_EXPRESSION_KEYWORD = /^(print|printf|return|exit|case|do|else|in)$/
const awkCode = (program: string, regex: boolean): string | undefined => {
  let code = ''
  let word = ''
  let operand = false
  const conditions: boolean[] = []
  for (let i = 0; i < program.length; i++) {
    const ch = program[i]!
    if (ch === '"') {
      let j = i + 1
      for (; j < program.length && program[j] !== '"'; j++) {
        if (program[j] === '\\') j++
        else if (program[j] === '\n') return undefined
      }
      if (j >= program.length) return undefined
      code += '""'
      operand = true
      word = ''
      i = j
    } else if (ch === '\\' && (program[i + 1] === '\n' || (program[i + 1] === '\r' && program[i + 2] === '\n'))) {
      // It joins the lines but still parts the tokens on either side: print\<newline>x.
      i += program[i + 1] === '\r' ? 2 : 1
      code += ' '
    } else if (ch === '/' && regex && !operand) {
      let j = i + 1
      for (; j < program.length && program[j] !== '/'; j++) {
        const r = program[j]!
        if (r === '\n') return undefined
        if (r === '\\') j++
        else if (r === '[') {
          // A bracket expression: a ] first is a member, and [: :] [. .] [= =] are units. awks
          // differ on a slash or a backslash inside one, so neither is followed.
          j++
          if (program[j] === '^') j++
          if (program[j] === ']') j++
          for (; j < program.length && program[j] !== ']'; j++) {
            const b = program[j]!
            if (b === '/' || b === '\\' || b === '\n') return undefined
            if (b === '[' && /[:.=]/.test(program[j + 1] ?? '')) {
              const close = program.indexOf(`${program[j + 1]}]`, j + 2)
              if (close < 0) return undefined
              j = close + 1
            }
          }
          if (j >= program.length) return undefined
        }
      }
      if (j >= program.length) return undefined
      code += '//'
      operand = true
      word = ''
      i = j
    } else if (ch === '#') {
      // A comment runs to the newline, a backslash before it included.
      while (i + 1 < program.length && program[i + 1] !== '\n') i++
    } else {
      code += ch
      if (/\w/.test(ch)) {
        word = /\w/.test(program[i - 1] ?? '') ? word + ch : ch
        operand = !AWK_EXPRESSION_KEYWORD.test(word)
      } else if (/\s/.test(ch)) {
        if (ch === '\n') operand = false
      } else {
        if (ch === '(') conditions.push(/^(if|while|for|switch)$/.test(word))
        if (ch === ')') operand = !conditions.pop()
        else operand = ch === ']' || ch === '.' || ((ch === '+' || ch === '-') && program[i - 1] === ch)
        word = ''
      }
    }
  }
  return code
}

// print or printf whose output goes on through >, >> or | writes a file or runs a command.
// Statements are split at ; { } alone: a newline may continue one after , && || and others.
const awkPrints = (code: string) =>
  code.split(/[;{}]/).some(statement => {
    const print = /(^|[^\w$])printf?\b/.exec(statement)
    if (!print) return false
    let depth = 0
    for (const ch of statement.slice(print.index + print[0].length)) {
      if (ch === '(') depth++
      else if (ch === ')') depth--
      else if (depth <= 0 && (ch === '>' || ch === '|')) return true
    }
    return false
  })

// An awk program reads unless it calls system(), reads a command through getline, loads or
// calls code by name (@load, @include, @f()), edits in place, or sends print output on.
// case and switch are keywords in gawk alone (not with --posix or in mawk), and a / after one
// is a regex or a division accordingly: a program naming either is not read.
const awkProgramReads = (program: string): boolean => {
  const banned = /system|getline|extension|inplace|@|\b(case|switch)\b/
  if (banned.test(program) || banned.test(program.replace(/\\\r?\n/g, ''))) return false
  const withRegex = awkCode(program, true)
  const withoutRegex = awkCode(program, false)
  return withRegex !== undefined && withoutRegex !== undefined && !awkPrints(withRegex) && !awkPrints(withoutRegex)
}

const AWK_FLAGS =
  /^(-[bcPSnrNsOVh]+|--(characters-as-bytes|traditional|posix|sandbox|non-decimal-data|re-interval|use-lc-numeric|no-optimize|optimize|version|help|usage|copyright))$/
// awk stops reading options at its program, and takes what follows as input files and
// assignments: only the words up to the program must reach it as written.
const awkReads = (args: string[], dynamic: boolean[]) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (dynamic[i]) return false
    if (a === '-F' || a === '-v' || a === '--assign' || a === '--field-separator') {
      if (dynamic[++i]) return false
    } else if (/^(-F|-v|--assign=|--field-separator=)/.test(a)) continue
    else if (a === '--') return args[i + 1] !== undefined && !dynamic[i + 1] && awkProgramReads(args[i + 1]!)
    // Any other option may load code or write a profile, a dump or a pretty-printed copy.
    else if (a.startsWith('-') && a !== '-') {
      if (!AWK_FLAGS.test(a)) return false
    }
    // The program; what follows it is input files and assignments.
    else return awkProgramReads(a)
  }
  return false
}

// uniq and xxd write their second operand: count operands as they do, numbers included.
const operands = (args: string[], valued: RegExp, flags: RegExp): number | undefined => {
  let n = 0
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') return n + args.length - i - 1
    if (valued.test(a)) i++
    else if (a.startsWith('-') && a !== '-') {
      if (!flags.test(a)) return undefined
    } else n++
  }
  return n
}
const uniqReads = (args: string[]) =>
  (operands(
    args,
    /^(-[fsw]|--(skip-fields|skip-chars|check-chars))$/,
    /^(-[cdDuiz]+|-[fsw]\d+|--(count|repeated|unique|ignore-case|zero-terminated|all-repeated(=\w+)?|group(=\w+)?|(skip-fields|skip-chars|check-chars)=\d+))$/,
  ) ?? 2) < 2
const xxdReads = (args: string[]) =>
  (operands(
    args,
    /^-(c|cols|g|groupsize|l|len|s|seek|o|offset|n|name|R)$/,
    /^-(a|autoskip|b|bits|C|capitalize|E|EBCDIC|e|i|include|p|ps|postscript|plain|u|d|h|help|v|version|[cglson][+-]?\w+)$/,
  ) ?? 2) < 2

// [[ evaluates the operands of -eq and the others as arithmetic, which runs any $( ) in an
// array subscript; -v does the same to its operand.
const doubleBracketReads = (args: string[], dynamic: boolean[]) =>
  args.every((a, i) => {
    if (a === '-v') return false
    if (!/^-(eq|ne|lt|le|gt|ge)$/.test(a)) return true
    return [i - 1, i + 1].every(j => !dynamic[j] && /^[+-]?\d+$/.test(args[j] ?? ''))
  })

// test and [ take the result of an expansion as an operator, so an expanded word may stand
// only where an operand must: after a unary operator, or beside a binary one.
const TEST_UNARY = /^-[bcdefghknprsStuwxzLGNO]$/
const TEST_BINARY = /^(=|==|!=|-eq|-ne|-lt|-le|-gt|-ge|-nt|-ot|-ef)$/
const testReads = (args: string[], dynamic: boolean[], bare: boolean[]) => {
  const n = args[args.length - 1] === ']' && !dynamic[args.length - 1] ? args.length - 1 : args.length
  for (let i = 0; i < n; i++) {
    if (!dynamic[i]) {
      if (args[i] === '-v') return false
      continue
    }
    if (bare[i]) return false
    const before = i > 0 && !dynamic[i - 1] ? args[i - 1]! : ''
    const after = i + 1 < n && !dynamic[i + 1] ? args[i + 1]! : ''
    if (!TEST_UNARY.test(before) && !TEST_BINARY.test(before) && !TEST_BINARY.test(after)) return false
  }
  return true
}

// set -x runs PS4 as code, set -a exports what is assigned after, set -k takes assignments
// anywhere as the environment: only errexit, nounset, pipefail, noglob and noclobber.
const setReads = (args: string[], dynamic: boolean[]) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--' && !dynamic[i]) return true // the rest set $1, $2, ...
    if (dynamic[i]) return false
    if (/^[-+][eufC]+$/.test(a)) continue
    if (!/^[-+][eufC]*o$/.test(a) || dynamic[++i] || !/^(errexit|nounset|pipefail|noglob|noclobber)$/.test(args[i] ?? '')) return false
  }
  return true
}

// export makes a variable reach every program run after it.
const exportReads = literal(args => args.every(a => /^-[pn]+$/.test(a) || SAFE_ENV.test(a.split('=')[0]!)))
// declare and its kin: no -x (export), -i (arithmetic), -n (a reference) or -f. A value in
// ( ) is a compound array assignment, which expands its elements, and with -a or -A even a
// quoted one is.
const declareReads = (args: string[], dynamic: boolean[]) => {
  const arrays = args.some(a => /^[-+]\w*[aA]/.test(a))
  return args.every(
    (a, i) =>
      (/^[-+][rpaAlug]+$/.test(a) && !dynamic[i]) ||
      (/^[A-Za-z_]\w*(=|$)/.test(a) && ordinary(a) && !(a.includes('=') && (arrays || a.slice(a.indexOf('=') + 1).startsWith('(')))),
  )
}

// sort writes its output with -o, and temporary files with -T.
const sortReads = literal(args => !args.some(a => /^-[a-zA-Z]*[oT]/.test(a) || abbreviates(a, ['--output', '--compress-program', '--temporary-directory'])))

// unset evaluates a subscript of a set variable as arithmetic: plain names only.
const unsetReads = literal(args => args.every(a => /^-[vfn]$/.test(a) || /^[A-Za-z_]\w*$/.test(a)))

// The readers, and for those with options or arguments that write, the check that rules them out.
const BASH: Record<string, Rule> = {
  find: literal(args => !args.some(a => /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(a))),
  fd: literal(args => !args.some(a => /^--exec(-batch)?(=|$)|^-[a-zA-Z]*[xX]/.test(a))),
  sed: literal(sedReads),
  awk: awkReads,
  gawk: awkReads,
  mawk: awkReads,
  sort: sortReads,
  uniq: literal(uniqReads),
  xxd: literal(args => !args.some(a => /^-r/.test(a)) && xxdReads(args)),
  file: literal(args => !args.some(a => /^-[a-zA-Z]*C/.test(a) || abbreviates(a, ['--compile']))),
  // -o writes its listing, and -R runs tree again with -o in each directory.
  tree: literal(args => !args.some(a => /^-[a-zA-Z]*[oR]/.test(a) || abbreviates(a, ['--output']))),
  date: literal(args => !args.some(a => /^-[a-zA-Z]*s/.test(a) || abbreviates(a, ['--set']))),
  hostname: literal(args => args.every(a => /^(-[sfdiIaAy]+|--(short|fqdn|long|domain|ip-address|all-ip-addresses|all-fqdns|alias|yp|nis))$/.test(a))),
  printf: (args, dynamic) => args[0] === '--' || (!dynamic[0] && !/^-v/.test(args[0] ?? '')),
  test: testReads,
  '[': testReads,
  '[[': doubleBracketReads,
  set: setReads,
  unset: unsetReads,
  export: exportReads,
  declare: declareReads,
  typeset: declareReads,
  readonly: declareReads,
  local: declareReads,
  git: literal(gitReads),
  gh: ghReads,
  npm: npmReads,
  graphify: literal(graphifyReads),
  rg: literal(rgReads),
}
for (const name of (
  'ls dir cat head tail grep egrep fgrep wc pwd echo which type stat du df cut tr jq diff cmp basename ' +
  'dirname realpath readlink printenv uname whoami nl od md5sum sha1sum sha256sum true false cd pushd ' +
  'popd sleep exit column comm seq rev paste join tac strings hexdump expand fold id groups locale'
).split(' '))
  BASH[name] = true

const bashReads = ({ words, quoted, dynamic, bare, raw, piped }: Command): boolean => {
  const w = [...words]
  const q = [...quoted]
  const d = [...dynamic]
  const b = [...bare]
  const r = [...raw]
  const shift = () => {
    q.shift()
    d.shift()
    b.shift()
    r.shift()
    return w.shift()!
  }
  // Shell grammar runs no program of its own: look past it to the command it guards.
  while (w.length && grammar(w[0]!, q[0], piped)) shift()
  if (!w.length || (!q[0] && /^(fi|done|esac|\})$/.test(w[0]!))) return true
  // for assigns each word to its variable: an ordinary name, then `in` and the words. Its body
  // follows a ; or a newline; `for x do ...` puts it in this same command.
  if (!q[0] && w[0] === 'for') {
    return (
      /^[A-Za-z_]\w*$/.test(r[1] ?? '') && ordinary(w[1]!) && (w.length === 2 || (w[2] === 'in' && !q[2])) &&
      !w.slice(3).some((x, i) => !q[i + 3] && /^(do|\{|done)$/.test(x))
    )
  }
  // An assignment's name and = are unquoted; 'x=1' is a command of that name.
  const env: string[] = []
  while (w.length && /^[A-Za-z_]\w*=/.test(r[0]!)) env.push(shift())
  // Assignments alone set shell variables, which is harmless unless the shell or a program
  // acts on the variable; before a command they may change what it runs.
  if (!w.length) return env.every(ordinary)
  if (!safeAssignments(env) || d[0]) return false
  const [name = '', ...args] = w
  // A path runs that file, which may be the project's own script named like a reader.
  if (/[\\/]/.test(name) && !/^(\/usr)?(\/local)?\/bin\/[^/]+$/.test(name)) return false
  const rule = BASH[name.split('/').pop()!.toLowerCase()]
  return rule === true || (rule !== undefined && rule(args, d.slice(1), b.slice(1)))
}

const foreachObjectReads = literal(args => args.every(a => /^-(begin|process|end)$/i.test(a)))

const PWSH: Record<string, Rule> = {
  git: literal(gitReads),
  gh: ghReads,
  npm: npmReads,
  graphify: literal(graphifyReads),
  rg: literal(rgReads),
  // Script blocks are read as commands of their own; -MemberName (or a bare name) calls a
  // method on each item. foreach is also the keyword, whose ( ) shows as one unseen word.
  'foreach-object': foreachObjectReads,
  '%': foreachObjectReads,
  foreach: (args, dynamic) => (args.length === 1 && args[0] === '' && dynamic[0]!) || foreachObjectReads(args, dynamic),
  // Off Windows, pwsh has no sort alias, and sort is GNU or BSD sort. Sort-Object's own
  // parameters are options GNU sort refuses, all but -Top (-T op: temporary files in op).
  sort: literal(args => args.every(a => !a.startsWith('-') || a === '-' || /^-(property|descending|unique|stable|casesensitive|culture|inputobject|bottom)$/i.test(a))),
}
for (const name of (
  'get-childitem gci ls dir get-content gc cat type select-string sls get-item gi test-path get-location gl pwd ' +
  'measure-object measure select-object select where-object where ? sort-object format-table ft format-list ' +
  'fl format-wide fw write-output echo write-host resolve-path rvpa get-command gcm get-filehash get-date out-null ' +
  'out-string out-host get-itemproperty gp split-path join-path convertto-json convertfrom-json group-object group ' +
  'compare-object diff get-unique get-member gm get-help get-variable gv set-location sl cd chdir push-location ' +
  'pushd pop-location popd get-process gps ps get-psdrive get-acl start-sleep sleep findstr ' +
  'if elseif else for while do switch try catch finally param begin process end break continue'
).split(' '))
  PWSH[name] = true

// What an assignment may set: a plain variable, typed or in a scope, or an environment
// variable that changes no program. $function:, $alias:, $c: and a property set run code.
const PS_TARGET = /^(\[[\w.\[\], ]+\])*(\$((global|script|local|private):)?\w+)?,?$/i
const assignable = (target: string) => {
  const env = /^\$env:(\w+),?$/i.exec(target)
  return env ? SAFE_ENV.test(env[1]!) : target !== '' && target !== ',' ? PS_TARGET.test(target) : target === ','
}

// Types a cast or -as may convert to without running a constructor that touches a file, as
// [IO.StreamWriter]'f' opens f. Every [Type] in the unquoted text must be one of them.
const PS_TYPES =
  /^(system\.)?(int|int16|int32|int64|uint16|uint32|uint64|long|short|ushort|ulong|uint|byte|sbyte|double|float|single|decimal|bigint|string|char|bool|boolean|switch|datetime|timespan|guid|version|regex|uri|array|hashtable|ordered|pscustomobject|psobject|object|void)(\[\])?$/i
// Checked on the command's unquoted text, words joined, as [ IO.StreamWriter] may be spaced.
const plainTypes = (text: string) => {
  for (let i = text.indexOf('['); i >= 0; i = text.indexOf('[', i + 1)) {
    if (!/^\[\s*[A-Za-z_]/.test(text.slice(i))) continue
    let depth = 0
    let j = i
    for (; j < text.length; j++) {
      if (text[j] === '[') depth++
      else if (text[j] === ']' && --depth === 0) break
    }
    if (j >= text.length || !PS_TYPES.test(text.slice(i + 1, j).replace(/\s/g, ''))) return false
    i = j
  }
  return true
}

// ++ and -- assign too, spaced or not: $c:file++ and $c:file ++ write the file c:file.
const STEPS = /(\$[\w:.[\]]+)\s*(?:\+\+|--)(?![\w-])|(?:\+\+|--)\s*(\$[\w:.[\]]+)/g
// -as converts to a type it may name as a string ('f' -as 'IO.StreamWriter' opens f): only a
// [Type] literal may follow it, which plainTypes then checks.
const UNCHECKED_AS = /(^|[^\w-])-as(?![\w-])(?!\s*\[)/i

// Programs PowerShell starts as processes. Windows PowerShell drops an empty argument to one,
// and splits an argument holding a quote or ending in a backslash, so git may get other words.
const NATIVE = /^(git|gh|npm|graphify|rg|findstr|sort)$/i

const pwshReads = (words: string[], quoted: boolean[], dynamic: boolean[], bare: boolean[], raw: string[], piped = false): boolean => {
  if (!words.length) return true
  // An assignment operator glued to its right side: $x =Remove-Item a.
  const glued = raw.findIndex((r, i) => i > 0 && /^(?:[-+*/%]|\?\?)?=[^=]/.test(r))
  if (glued > 0) {
    const at = raw[glued]!.indexOf('=') + 1
    const two = <T,>(list: T[], a: T, b: T) => [...list.slice(0, glued), a, b, ...list.slice(glued + 1)]
    return pwshReads(
      two(words, words[glued]!.slice(0, at), words[glued]!.slice(at)),
      two(quoted, false, raw[glued]!.slice(at).includes('\0')),
      two(dynamic, false, dynamic[glued]!),
      two(bare, false, bare[glued]!),
      two(raw, raw[glued]!.slice(0, at), raw[glued]!.slice(at)),
      piped,
    )
  }
  if (words.some((w, i) => w === '--%' && !quoted[i])) return false // passes the rest on unparsed, %VARS% expanded
  const text = raw.join(' ')
  if (!plainTypes(text) || UNCHECKED_AS.test(text)) return false
  if ([...text.matchAll(STEPS)].some(m => !assignable(m[1] ?? m[2]!))) return false
  const slice = (from: number) =>
    pwshReads(words.slice(from), quoted.slice(from), dynamic.slice(from), bare.slice(from), raw.slice(from))
  // An assignment runs only what is on its right: $x = Get-Item a, [int]$n = 1, $a, $b = 1, 2.
  const op = words.findIndex((w, i) => !quoted[i] && /^([-+*/%]|\?\?)?=$/.test(w))
  if (op > 0) return words.slice(0, op).every((w, i) => !quoted[i] && assignable(w)) && slice(op + 1)
  const eq = /^([^=\0]*?)(([-+*/%]|\?\?)?=)/.exec(raw[0] ?? '')
  if (eq && /^[$[]/.test(eq[1]!)) {
    if (!assignable(eq[1]!)) return false
    const rhs = words[0]!.slice(eq[0].length)
    const rhsRaw = raw[0]!.slice(eq[0].length)
    return rhs
      ? pwshReads([rhs, ...words.slice(1)], [rhsRaw.includes('\0'), ...quoted.slice(1)], dynamic, bare, [rhsRaw, ...raw.slice(1)])
      : slice(1)
  }
  const [first = '', ...args] = words
  // return, exit and throw run the pipeline that follows them, and so does foreach's `in`.
  if (/^(return|exit|throw)$/i.test(first) && !quoted[0]) return slice(1)
  if (first.startsWith('$') && /^in$/i.test(args[0] ?? '') && !quoted[1]) return slice(2)
  // A string alone starts an expression. A word only partly quoted names a command, as
  // New-Item'' does, and so does a string after . or &.
  if (quoted[0]) return !/[^\0]/.test(raw[0] ?? '') && (args.length === 0 || /^-[A-Za-z]/.test(args[0]!))
  // A path runs that program, whatever it starts with: .git/../cmd.exe, 1\..\cmd.exe.
  if (first === '.' || /[\\/]/.test(first)) return false
  // A value, a variable, an operator or a member of the last expression is no program.
  if (/^[$!,-]/.test(first) || /^\d[\w.,]*$/.test(first) || /^\.[A-Za-z_]\w*$/.test(first)) return true
  if (first.startsWith('[')) return !first.includes('::') && args.every((a, i) => a === '' && dynamic[i + 1])
  if (args.some((a, i) => a === '' && quoted[i + 1])) return false
  if (NATIVE.test(first) && args.some(a => a.includes('"') || a.endsWith('\\'))) return false
  // After a |, foreach is ForEach-Object, and foreach ('Delete') calls Delete on each item.
  if (piped && first.toLowerCase() === 'foreach') return foreachObjectReads(args, dynamic.slice(1))
  const rule = PWSH[first.toLowerCase()]
  return rule === true || (rule !== undefined && rule(args, dynamic.slice(1), bare.slice(1)))
}

// True when the command may change a file.
export const mayWrite = (command: string, shell: Shell): boolean => {
  const commands = shell === 'bash' ? bashCommands(command) : pwshCommands(command)
  if (!commands) return true
  return commands.some(c => !(shell === 'bash' ? bashReads(c) : pwshReads(c.words, c.quoted, c.dynamic, c.bare, c.raw, c.piped)))
}
