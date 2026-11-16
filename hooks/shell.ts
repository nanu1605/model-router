// Tells a shell command that only reads from one that may change files. A command reads only
// when every program it runs is a known reader, used in a reading way. Anything the parser
// cannot follow (command substitution, a heredoc, an open quote, a method call) is a write.

export type Shell = 'bash' | 'pwsh'

type Command = { words: string[]; quoted: boolean[] }

// Collects words into commands; `undefined` from a reader below means "runs code we cannot see".
const collector = () => {
  const out: Command[] = []
  let words: string[] = []
  let quoted: boolean[] = []
  const at = { word: '', open: false, quoted: false }
  const endWord = () => {
    if (at.open) {
      words.push(at.word)
      quoted.push(at.quoted)
    }
    at.word = ''
    at.open = false
    at.quoted = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) out.push({ words, quoted })
    words = []
    quoted = []
  }
  const add = (text: string, isQuoted = false) => {
    at.word += text
    at.open = true
    at.quoted ||= isQuoted
  }
  // A number just before `>` or `<` is the redirect's descriptor, not a word.
  const dropDescriptor = () => {
    if (at.open && !at.quoted && /^[\d*]+$/.test(at.word)) {
      at.word = ''
      at.open = false
    }
  }
  return { out, at, endWord, endCommand, add, dropDescriptor, isEmpty: () => words.length === 0 && !at.open }
}

// The word a redirect names, from `i`: its text and the index of its last character, or -1
// when it hides code.
const target = (s: string, from: number, shell: Shell): [string, number] => {
  let i = from
  while (s[i] === ' ' || s[i] === '\t') i++
  let t = ''
  for (; i < s.length && !/[\s;&|()<>{}]/.test(s[i]!); i++) {
    const c = s[i]!
    if (c === "'" || c === '"') {
      const j = s.indexOf(c, i + 1)
      if (j < 0) return ['', -1]
      const inner = s.slice(i + 1, j)
      if (c === '"' && /\$\(|`/.test(inner)) return ['', -1]
      t += inner
      i = j
    } else if (c === '`' && shell === 'bash') return ['', -1]
    else if (c === '\\' && shell === 'bash') t += s[++i] ?? ''
    else t += c
  }
  return [t, i - 1]
}

// After `>` at index i: the index the redirect ends at, or -1 when it writes a file.
const redirect = (s: string, i: number, shell: Shell): number => {
  let j = i + 1
  if (s[j] === '>' || s[j] === '|') j++
  if (s[j] === '&') {
    // Onto another descriptor: 2>&1, >&2, >&-.
    j++
    while (/[\d-]/.test(s[j] ?? '')) j++
    return j - 1
  }
  const [name, end] = target(s, j, shell)
  if (end < 0) return -1
  const nowhere = shell === 'bash' ? name === '/dev/null' : /^(\$null|nul)$/i.test(name)
  return nowhere ? end : -1
}

const bashCommands = (s: string): Command[] | undefined => {
  if (/\$\{[^}]*@P/.test(s)) return undefined
  const c = collector()
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    const next = s[i + 1]
    if (ch === '\\') {
      if (next !== '\n') c.add(next ?? '')
      i++
    } else if (ch === "'") {
      const j = s.indexOf("'", i + 1)
      if (j < 0) return undefined
      c.add(s.slice(i + 1, j), true)
      i = j
    } else if (ch === '$' && next === "'") {
      let j = i + 2
      for (; j < s.length && s[j] !== "'"; j++) if (s[j] === '\\') j++
      if (j >= s.length) return undefined
      c.add(s.slice(i + 2, j), true)
      i = j
    } else if (ch === '"') {
      let j = i + 1
      let text = ''
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '`' || (s[j] === '$' && s[j + 1] === '(')) return undefined
        if (s[j] === '\\') j++
        text += s[j] ?? ''
      }
      if (j >= s.length) return undefined
      c.add(text, true)
      i = j
    } else if (ch === '`' || (ch === '$' && next === '(') || ((ch === '<' || ch === '>') && next === '(')) {
      return undefined
    } else if (ch === '#' && !c.at.open) {
      while (i + 1 < s.length && s[i + 1] !== '\n') i++
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      c.endWord()
    } else if (ch === '\n' || ch === ';' || ch === '(' || ch === ')') {
      c.endCommand()
    } else if (ch === '|') {
      c.endCommand()
      if (next === '|' || next === '&') i++
    } else if (ch === '&' && next === '>') {
      c.endWord()
      i = redirect(s, i + 1, 'bash')
      if (i < 0) return undefined
    } else if (ch === '&') {
      c.endCommand()
      if (next === '&') i++
    } else if (ch === '>') {
      c.dropDescriptor()
      c.endWord()
      i = redirect(s, i, 'bash')
      if (i < 0) return undefined
    } else if (ch === '<') {
      c.dropDescriptor()
      c.endWord()
      if (next === '>') return undefined // opens the file for writing too
      if (next === '<' && s[i + 2] !== '<') return undefined // a heredoc
      if (next === '&') {
        i += 2
        while (/[\d-]/.test(s[i] ?? '')) i++
        i--
        continue
      }
      // An input file, or a here-string's text: read, never run.
      const [, end] = target(s, next === '<' ? i + 3 : i + 1, 'bash')
      if (end < 0) return undefined
      i = end
    } else {
      c.add(ch)
    }
  }
  c.endCommand()
  return c.out
}

const pwshCommands = (s: string): Command[] | undefined => {
  const c = collector()
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    const next = s[i + 1]
    if (ch === '`') {
      if (next === '\r' && s[i + 2] === '\n') i++
      else if (next !== '\n') c.add(next ?? '')
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
      for (; j < s.length; j++) {
        if (s[j] === '`') {
          text += s[++j] ?? ''
          continue
        }
        if (s[j] === '$' && s[j + 1] === '(') return undefined
        if (s[j] === '"') {
          if (s[j + 1] !== '"') break
          j++
        }
        text += s[j]
      }
      if (j >= s.length) return undefined
      c.add(text, true)
      i = j
    } else if (ch === '@' && (next === "'" || next === '"') && !c.at.open) {
      // A here-string: its text runs to a line that starts with the quote and @.
      const end = s.indexOf(`\n${next}@`, i + 2)
      if (end < 0) return undefined
      const text = s.slice(i + 2, end)
      if (next === '"' && /\$\(/.test(text)) return undefined
      c.add(text, true)
      i = end + 2
    } else if (ch === '<' && next === '#') {
      const end = s.indexOf('#>', i + 2)
      if (end < 0) return undefined
      i = end + 1
    } else if (ch === '#' && !c.at.open) {
      while (i + 1 < s.length && s[i + 1] !== '\n') i++
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      c.endWord()
    } else if (ch === '(') {
      // A method call runs code the words do not show: $f.Delete(), [IO.File]::Delete('x').
      if (c.at.open && !c.at.quoted && /(\.|::)[A-Za-z_]\w*$/.test(c.at.word)) return undefined
      // $( and @( open a sub-pipeline, read as commands of their own.
      if (c.at.open && (c.at.word === '$' || c.at.word === '@')) {
        c.at.word = ''
        c.at.open = false
      }
      c.endCommand()
    } else if (ch === '\n' || ch === ';' || ch === ')' || ch === '{' || ch === '}') {
      c.endCommand()
    } else if (ch === '|') {
      c.endCommand()
      if (next === '|') i++
    } else if (ch === '&') {
      if (next === '&') {
        c.endCommand()
        i++
      } else if (next === '>') {
        c.endWord()
        i = redirect(s, i + 1, 'pwsh')
        if (i < 0) return undefined
      } else if (c.isEmpty()) {
        return undefined // the call operator runs whatever follows
      } else {
        c.endCommand()
      }
    } else if (ch === '>') {
      c.dropDescriptor()
      c.endWord()
      i = redirect(s, i, 'pwsh')
      if (i < 0) return undefined
    } else if (ch === '<') {
      return undefined
    } else {
      c.add(ch)
    }
  }
  c.endCommand()
  return c.out
}

// Variables a command may be run with without changing what it does to files.
const SAFE_ENV = /^(LANG|LANGUAGE|LC_\w+|NO_COLOR|FORCE_COLOR|CLICOLOR\w*|TERM|TZ|CI|COLUMNS|LINES)$/
const safeAssignments = (args: string[]) =>
  args.every(a => !/^[A-Za-z_]\w*=/.test(a) || SAFE_ENV.test(a.slice(0, a.indexOf('='))))

const nonOptions = (args: string[]) => args.filter(a => !a.startsWith('-') && !/^(\d+|0x[\da-f]+)$/i.test(a))

const GIT_READS = new Set(
  (
    'status log diff show rev-parse ls-files blame grep cat-file ls-tree describe shortlog rev-list merge-base ' +
    'for-each-ref show-ref check-ignore diff-tree name-rev count-objects help version'
  ).split(' '),
)

const gitReads = (args: string[]): boolean => {
  let i = 0
  for (; i < args.length; i++) {
    const a = args[i]!
    // Config set here runs commands of its own choosing: core.pager, diff.external, core.fsmonitor.
    if (a === '-c' || /^-c./.test(a) || /^-C./.test(a) || /^--(config-env|exec-path)/.test(a)) return false
    if (a === '-C' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') i++
    else if (!a.startsWith('-')) break
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (rest.some(a => /^--output(=|$)|^-O|^--open-files-in-pager|^--ext-diff$|^--textconv$/.test(a))) return false
  switch (sub) {
    case 'branch':
      return rest.every(a => /^(-a|-r|-v|-vv|-l|--list|--all|--remotes|--verbose|--show-current|--no-color|--color(=\w+)?)$/.test(a))
    case 'remote':
      return rest.every(a => /^(-v|--verbose)$/.test(a)) || /^(show|get-url)$/.test(rest[0] ?? '')
    case 'stash':
      return /^(list|show)$/.test(rest[0] ?? '')
    case 'config':
      return (
        rest.some(a => /^(--get(-all|-regexp)?|--list|-l|get|list)$/.test(a)) &&
        !rest.some(a => /^(--add|--unset|--replace-all|--rename-section|--remove-section|-e|--edit|set|unset)/.test(a))
      )
    case 'worktree':
      return rest[0] === 'list'
    case 'tag':
      return rest.length === 0 || (rest.some(a => /^(-l|--list)$/.test(a)) && !rest.some(a => /^(-d|--delete|-a|-s|-f|-m)$/.test(a)))
    case 'reflog':
      return !/^(expire|delete)$/.test(rest[0] ?? '')
    default:
      return sub !== undefined && GIT_READS.has(sub)
  }
}

const ghReads = (args: string[]) =>
  args[0] === 'status' ||
  (/^(pr|issue|run|repo|release|workflow|auth)$/.test(args[0] ?? '') && /^(view|list|diff|checks|status)$/.test(args[1] ?? ''))

const rgReads = (args: string[]) => !args.some(a => /^--pre(=|$)/.test(a))

// sed reads when its script only prints, deletes from the output or substitutes, with no w or e.
const SED_OPTS = /^(-[nEsuzr]+|--(quiet|silent|regexp-extended|separate|unbuffered|null-data|posix|debug|sandbox))$/
const ADDRESS = String.raw`((\d+|\$|\/[^/]*\/)(,(\d+|\$|\/[^/]*\/))?)?`
const SED_LINE = new RegExp(`^${ADDRESS}[pdq=]?$`)
const SED_SUB = new RegExp(String.raw`^${ADDRESS}s(.)(?:(?!\5)[^\\]|\\.)*\5(?:(?!\5)[^\\]|\\.)*\5[gpiIm0-9]*$`)
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

const awkReads = (args: string[]) => {
  let program: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (/^(-f|--file|-i|--include|-l|--load|-E|--exec)/.test(a) || /inplace/.test(a)) return false
    if (a === '-F' || a === '-v' || a === '--assign' || a === '--field-separator') i++
    else if (!a.startsWith('-')) program ??= a
  }
  return program !== undefined && !/system\s*\(|\||>|getline|inplace/.test(program)
}

// The readers, and for those with options or arguments that write, the check that rules them out.
const BASH: Record<string, true | ((args: string[]) => boolean)> = {
  find: args => !args.some(a => /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(a)),
  fd: args => !args.some(a => /^--exec(-batch)?(=|$)|^-[a-zA-Z]*[xX]/.test(a)),
  sed: sedReads,
  awk: awkReads,
  gawk: awkReads,
  sort: args => !args.some(a => /^-[a-zA-Z]*o|^--output|^--compress-program/.test(a)),
  uniq: args => nonOptions(args).length < 2,
  xxd: args => !args.some(a => /^-r/.test(a)) && nonOptions(args).length < 2,
  file: args => !args.some(a => /^(-C|--compile)$/.test(a)),
  tree: args => !args.some(a => a === '-o'),
  date: args => !args.some(a => /^(-s|--set)/.test(a)),
  hostname: args => args.every(a => a.startsWith('-')),
  export: safeAssignments,
  declare: safeAssignments,
  typeset: safeAssignments,
  readonly: safeAssignments,
  local: safeAssignments,
  git: gitReads,
  gh: ghReads,
  rg: rgReads,
}
for (const name of (
  'ls dir cat head tail grep egrep fgrep wc pwd echo printf which type stat du df cut tr jq diff cmp basename ' +
  'dirname realpath readlink printenv uname whoami nl od md5sum sha1sum sha256sum true false test [ [[ cd pushd ' +
  'popd unset set sleep exit column comm seq rev paste join tac strings hexdump expand fold id groups locale'
).split(' '))
  BASH[name] = true

const bashReads = (words: string[]): boolean => {
  const w = [...words]
  // Shell grammar runs no program of its own: look past it to the command it guards.
  while (w.length && /^(then|do|else|elif|if|while|until|time|!|\{)$/.test(w[0]!)) w.shift()
  if (!w.length || /^(fi|done|esac|\}|for)$/.test(w[0]!)) return true
  const env: string[] = []
  while (w.length && /^[A-Za-z_]\w*=/.test(w[0]!)) env.push(w.shift()!)
  // Assignments alone set shell variables; before a command they may change what it runs.
  if (!w.length) return true
  if (!safeAssignments(env)) return false
  const [name = '', ...args] = w
  // A path runs that file, which may be the project's own script named like a reader.
  if (/[\\/]/.test(name) && !/^(\/usr)?(\/local)?\/bin\/[^/]+$/.test(name)) return false
  const rule = BASH[name.split('/').pop()!.toLowerCase()]
  return rule === true || (rule !== undefined && rule(args))
}

const PWSH: Record<string, true | ((args: string[]) => boolean)> = {
  git: gitReads,
  gh: ghReads,
  rg: rgReads,
  // Its script blocks are read as commands of their own; -MemberName calls a method on each item.
  'foreach-object': args => args.every(a => /^-(begin|process|end)$/i.test(a)),
  '%': args => args.every(a => /^-(begin|process|end)$/i.test(a)),
}
for (const name of (
  'get-childitem gci ls dir get-content gc cat type select-string sls get-item gi test-path get-location gl pwd ' +
  'measure-object measure select-object select where-object where ? sort-object sort format-table ft format-list ' +
  'fl format-wide fw write-output echo write-host resolve-path rvpa get-command gcm get-filehash get-date out-null ' +
  'out-string out-host get-itemproperty gp split-path join-path convertto-json convertfrom-json group-object group ' +
  'compare-object diff get-unique get-member gm get-help get-variable gv set-location sl cd chdir push-location ' +
  'pushd pop-location popd get-process gps ps get-psdrive get-acl start-sleep sleep exit findstr ' +
  'if elseif else for foreach while do switch try catch finally param begin process end return break continue'
).split(' '))
  PWSH[name] = true

const pwshReads = (words: string[], quoted: boolean[]): boolean => {
  const [first = '', ...args] = words
  if (!first) return true
  // An assignment runs only what is on its right: $x = Get-Item a, $env:X='1', @{ n = 'a' }.
  const assigned = /^(\$?[\w:.\[\]]*)([-+*/%]?=)(.*)$/.exec(first)
  if (assigned && assigned[1] && !quoted[0]) {
    return assigned[3] ? pwshReads([assigned[3], ...args], [false, ...quoted.slice(1)]) : pwshReads(args, quoted.slice(1))
  }
  if (first.startsWith('$') && /^[-+*/%]?=$/.test(args[0] ?? '')) return pwshReads(args.slice(1), quoted.slice(2))
  // A value, a variable, an operator or a member of the last expression is no program.
  if (quoted[0] || /^[$\d!,-]/.test(first) || /^\.[A-Za-z_]/.test(first)) return true
  if (first.startsWith('[')) return !first.includes('::')
  if (first === '.' || /[\\/]/.test(first)) return false
  const rule = PWSH[first.toLowerCase()]
  return rule === true || (rule !== undefined && rule(args))
}

// True when the command may change a file.
export const mayWrite = (command: string, shell: Shell): boolean => {
  const commands = shell === 'bash' ? bashCommands(command) : pwshCommands(command)
  if (!commands) return true
  return commands.some(c => !(shell === 'bash' ? bashReads(c.words) : pwshReads(c.words, c.quoted)))
}
