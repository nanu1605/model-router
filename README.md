# model-router

A Claude Code mod that makes the main model an orchestrator: it splits work into tasks, hands each to a subagent, and picks which model that subagent runs on (haiku, sonnet or opus).

## How it works

- **Routing rules in the system prompt.** The main model is told to set `model` on every Agent call: haiku for lookup and mechanical work, sonnet for ordinary coding, opus for design, root-causing and synthesis.
- **Fallback router.** If the main model picks no model, or one outside those three, the mod chooses by agent type, then by keywords in the task description, and defaults to sonnet. A full model id such as `claude-haiku-5-5` is normalised to its alias. Forks keep the parent model.
- **Feedback.** The status line shows `route: <type> -> <model>` for each spawn. `/route` prints counts per tier and the last ten tasks; a `*` marks those the fallback chose.

To change the policy, edit the `POLICY` text and the `BY_TYPE`, `OPUS` and `HAIKU` tables at the top of `hooks/register.ts`.

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
