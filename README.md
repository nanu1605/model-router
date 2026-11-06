# model-router

A Claude Code mod that makes the main model an orchestrator: it splits work into tasks, hands each to a subagent, and picks which model that subagent runs on (haiku, sonnet or opus).

## How it works

- **Routing rules in the system prompt.** Wherever the Agent tool is offered, the main model is told to set `model` on every Agent call: haiku for lookup and mechanical work, sonnet for ordinary coding, opus for design, root-causing and synthesis. It is also told that a subagent sees none of the conversation, so each brief must carry the goal, paths, constraints and what to report, and to escalate a weak result one tier up.
- **Strict: the main model always decides.** An Agent call the model makes with no model, or one outside those three (`inherit`, `fable`), is refused with the rules as the error, and the model calls again with a pick of its own. There is no guessing. Because every Agent call then names a model, that pick takes precedence over both a custom agent's own `model:` frontmatter and the configured default subagent model. Only a setting that forces one model on every subagent still wins, and the mod shows that as `asked->ran`.
- **Picks are passed on as given.** The mod never rewrites the call; it only checks it. Forks keep the parent model, and agents started by a Workflow script or by another plugin are left alone.
- **Usage tracking.** Each routed agent, teammates included, is recorded with its tokens in and out (summed over all its requests), time, outcome and the model that actually answered. A resumed agent or a teammate taking its next turn shows as running again, and its runs add up. If that differs from the pick (a setting that forces one subagent model, or an overload fallback), a toast says so and the row shows `asked->ran`.
- **Feedback.** The status line shows `route: 2 running (opus, haiku)` and clears when none run. `/route` prints, per tier, runs, failures, tokens and average time, then the last ten tasks. `/route pane` opens a live side panel with the same view, updated as agents start and finish.

To change the policy, edit the `POLICY` and `DENY` texts at the top of `hooks/register.tsx`.

## What it hooks

| Hook | What it does |
| --- | --- |
| `prompt.compose` | Appends one section, `model-router:policy`, holding the routing rules above, to the system prompt of a request that offers the Agent tool. Every other section, and every prompt without the Agent tool, is passed on unchanged. |
| `tool.call` on `Agent` | For an Agent call the model makes: refuses it, with the rules as the error text, when `model` is not haiku, sonnet or opus; otherwise runs it unchanged and records the result's agent id, model, tokens and time. A fork, and an Agent call made by another plugin, pass through untouched. |
| `turn.start` | Marks a recorded subagent or teammate as running again when it starts another turn. Passes the event on unchanged. |
| `turn.complete` | Reads a subagent's outcome, time, tokens and answering model for its record. Passes the event on unchanged. |
| `command.run` on `route` | Answers its own `/route` command only. |
| `ui.render` on its own pane | Draws only the `model-router` pane that `/route pane` opens. |
| `session.start` | Registers the `/route` command. |

The mod makes no permission decisions: it does not hook permission checks, change permission modes, write settings, or touch files, processes or the network. Its record lives in session state and is gone when the session ends.

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
