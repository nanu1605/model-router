# model-router

A Claude Code mod that makes the main model an orchestrator: it splits work into tasks, hands each to a subagent, and picks which model that subagent runs on (haiku, sonnet or opus).

## How it works

- **Routing rules in the system prompt.** Wherever the Agent tool is offered, the main model is told to set `model` on every Agent call: haiku for lookup and mechanical work, sonnet for ordinary coding, opus for design, root-causing and synthesis. It is also told that a subagent sees none of the conversation, so each brief must carry the goal, paths, constraints and what to report, and to escalate a weak result one tier up.
- **Strict: the main model always decides.** An Agent call the model makes with no model, or one outside those three (`inherit`, `fable`), is refused with the rules as the error, and the model calls again with a pick of its own. There is no guessing. This also overrides a custom agent's own `model:` frontmatter, since the main model always picks.
- **Picks are passed on as given.** `opus[1m]` keeps its 1M context and a pinned id such as `claude-sonnet-4-5` keeps its version. Forks keep the parent model, workflow agents keep what their script chose, and spawns made by other plugins are left alone.
- **Usage tracking.** Each routed agent is recorded with its tokens in and out, time, outcome and the model that actually answered. If that differs from the pick (a setting that forces one subagent model, or an overload fallback), a toast says so and the row shows `asked->ran`.
- **Feedback.** The status line shows `route: 2 running (opus, haiku)` and clears when none run. `/route` prints, per tier, runs, failures, tokens and average time, then the last ten tasks. `/route pane` opens a live side panel with the same view, updated as agents start and finish.

To change the policy, edit the `POLICY` and `DENY` texts at the top of `hooks/register.tsx`.

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
