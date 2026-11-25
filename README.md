# model-router

A Claude Code mod that puts each piece of work on the model it needs (haiku, sonnet or opus) and keeps the writing of code on opus. The main model becomes an orchestrator: it splits work into tasks, hands each to a subagent and picks that subagent's model. Each turn of the main conversation runs on the model its message needs, whatever model you picked. Every file change, from the main conversation or any agent, is made by opus.

## How it works

- **Each turn on the model it needs.** Before a turn's first request, one small haiku call reads your message and the reply it answers, and picks a tier. It picks haiku when the answer comes from the conversation or from reading files ("what is left to build?", "where is the parser?"), and sonnet for reasoning that changes no file and runs nothing (a review, a plan, comparing options). It picks opus for anything that edits, runs tests or builds, designs or decides something hard, and whenever it is unsure. Every request of that turn then goes out on that tier, unless moving down would cost more than staying (see What it costs). A message you type into a running turn puts the rest of that turn back on the model you picked. A model whose name says no tier (a Bedrock profile ARN, a gateway alias) is left alone. `/route auto off` keeps turns on the model you picked; `/route auto on` turns routing back on.
- **Only the latest opus writes.** When a turn or an agent that is not on the latest opus does any of the following, the call is refused once and is not run:
  - calls Edit, Write or NotebookEdit;
  - runs a shell command that may change files, through Bash, PowerShell, Monitor or the terminal tool;
  - removes a worktree.

  That turn, or that agent for the rest of its life, then moves to opus. Opus is told the refused call was drafted by a cheaper model, so it re-reads what the call touches and writes the change itself rather than copying it. Only a command that just checks something, like a test run, may be run again as it was.

  A shell command counts as reading only when every program in it is a known reader used in a reading way (`ls`, `cat`, `grep`, `git status`, `git log`, `git ls-remote`, `sed -n '1,20p'`, `awk 'NR>=10'`, `gh pr view`, `gh api` with GET, `npm view`, `graphify query`, `Get-ChildItem`, ...) and nothing is redirected into a file. The command is parsed with each shell's own quoting, escapes and comments. A command substitution such as `$(git ls-files | wc -l)` reads when the command inside it does. A word the shell expands (a variable, a substitution, a glob, a brace list) may turn into other words, so a reader with options that write (`find`, `sed`, `git`, ...) must get its arguments as written. Anything the parser cannot follow counts as a write: backquotes, a heredoc, arithmetic, a PowerShell method call, a cast to a type that opens files. Test runs, builds, installs, scripts and commands run over ssh move the turn to opus. This is a parser, not a sandbox: it was checked against over seventy ways to slip a write past it, each now a test, but a shell has more corners than any list, so treat it as a strong guard rather than a proof. This rule stays on with `/route auto off`. "Latest" is the newest opus the mod knows (Opus 5.5), raised whenever an agent asked for `opus` resolves to a newer one; the `opus` alias always counts.
- **Routing rules in the system prompt.** Wherever the Agent tool is offered, the main model is told to set `model` on every Agent call: haiku for lookup and reading, sonnet for reasoning that changes no file, opus for every task that edits code or files and for design, root-causing and synthesis. It is also told that a subagent sees none of the conversation, so each brief must carry the goal, paths, constraints and what to report, and to escalate a weak result one tier up.
- **Strict: the main model always decides.** An Agent call the model makes with no model, or one outside those three (`inherit`, `fable`), is refused with the rules as the error, and the model calls again with a pick of its own. There is no guessing. Because every Agent call then names a model, that pick takes precedence over both a custom agent's own `model:` frontmatter and the configured default subagent model. Only a setting that forces one model on every subagent still wins, and the mod shows that as `asked->ran`.
- **Picks are passed on as given.** The mod never rewrites the Agent call; it only checks it. An agent's model changes later only if it tries to write while not on opus. Forks keep the parent model, and agents started by a Workflow script or by another plugin skip the pick check (the opus-only write rule still applies to them).
- **Usage tracking.** Each routed agent, teammates included, is recorded with its tokens in and out (summed over all its requests), time, outcome and the model that actually answered. A resumed agent or a teammate taking its next turn shows as running again, and its runs add up. If that differs from the pick (a setting that forces one subagent model, or an overload fallback), a toast says so and the row shows `asked->ran`.
- **Feedback.** The status line shows `route: turn on haiku · 2 running (opus, haiku)` and clears when nothing runs; a turn that a write moved shows `haiku->opus`, and a toast says why. `/route` prints whether turn routing is on, then per tier runs, failures, tokens and average time, then the last ten turns and tasks (`main: <your message>` for a turn). `/route pane` opens a live side panel with the same view.

**What it costs.** The pick is one haiku request per turn: a few hundred tokens, and at most five seconds before the turn starts. If it fails or times out, the turn stays on your model.

Prompt caches are kept per model. A turn that moves down a tier therefore pays to write the whole conversation into the new model's cache, while staying would have read it cheaply from the current model's cache, if that cache is still warm. So the mod moves a turn down only when its estimate says that costs less. The estimate uses list prices, the conversation's size, about 3,000 output tokens, and whether the current model's cache is still alive. That cache's lifetime, five minutes or an hour, is learned from what the conversation's own requests find cached after a pause. In practice:
- Haiku is used for light turns until the conversation passes about 100K tokens, where haiku's price rises; past that, only if your model's cache has gone cold.
- Sonnet is used only when your model's cache has gone cold.
- Moving up a tier is about quality and always happens.

To change the policy, edit the `POLICY`, `PICK`, `DENY` and `WRITE_DENY` texts at the top of `hooks/register.tsx`.

## What it hooks

| Hook | What it does |
| --- | --- |
| `prompt.compose` | Appends one section, `model-router:policy`, holding the routing rules above, to the system prompt of a request that offers the Agent tool. Every other section, and every prompt without the Agent tool, is passed on unchanged. |
| `tool.call` on `Agent` | For an Agent call the model makes: refuses it, with the rules as the error text, when `model` is not haiku, sonnet or opus; otherwise runs it unchanged and records the result's agent id, model, tokens and time. A fork, and an Agent call made by another plugin, pass through untouched. |
| `tool.call` | For a call the model makes to Edit, Write or NotebookEdit, a Bash, PowerShell, Monitor or terminal command that may change files, or a worktree removal, from a turn or agent whose last request was not on the latest opus: refuses it once, with a text saying the turn or agent now continues on opus, and marks it to move. Every other call passes through untouched. |
| `turn.step` | Sends each request of the main conversation on the tier picked for its turn, and each request of a turn or agent marked to move on opus. Only the model is rewritten; the request is otherwise the engine's own. |
| `prompt.submit` | Notes a message you type into a running turn, so the rest of that turn goes back to your model; a background task's notice delivered into the turn changes nothing. Passes the prompt on unchanged. |
| `session.end` | On `/clear` or a resume, forgets the last reply and which models' caches were warm. Passes the event on unchanged. |
| `turn.start` | Records the message a main turn starts with; marks a recorded subagent or teammate as running again when it starts another turn. Passes the event on unchanged. |
| `turn.complete` | Reads the outcome, time, tokens and answering model of a main turn or a subagent for its record. Passes the event on unchanged. |
| `command.run` on `route` | Answers its own `/route` command only, `/route auto on` and `/route auto off` included. |
| `ui.render` on its own pane | Draws only the `model-router` pane that `/route pane` opens. |
| `session.start` | Registers the `/route` command. |

The mod makes no permission decisions: it does not hook permission checks or change permission modes, and a call it refuses is refused only to be made again on opus. It writes no settings and touches no files or processes. Its one call out is the per-turn haiku request, made through Claude Code's own model access; it also reads the context size Claude Code already shows in its status line. The `/route auto` choice is kept in the mod's own store; its record lives in session state and is gone when the session ends.

## Install

At the prompt of a terminal session:

```
/plugin install model-router --marketplace nanu1605/model-router
```

From a shell:

```
claude plugin install model-router --marketplace nanu1605/model-router
```

Answer `y` to add the marketplace, then pick a scope. The mod is active in that session straight away.

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `nanu1605/model-router`, then Add plugin.

## Test

```
claude plugin test .
```
