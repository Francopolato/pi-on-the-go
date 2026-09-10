# pi-on-the-go

Control your [pi](https://github.com/earendil-works/pi) coding agent from anywhere — for example over **Telegram**, while you are away from the machine. No desktop, no remote-desktop session: just a chat message.

This repository contains custom [pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) designed for **remote use**: the agent exposes session-control actions as tools it can trigger on its own, so a single message from your phone is enough.

## Extensions

### `tg-session-ctl.ts` — session control from Telegram

Lets you (via chat) manage the pi session without touching a keyboard:

| You say / type | What happens |
|---|---|
| "new chat" / "nuova chat" | starts a brand-new empty session — **preserving the active model and thinking level** of the previous chat (pi's `newSession()` otherwise resets both to the process launch-time `--model`) |
| "reload" | full runtime reload — extensions, skills, prompts, themes, context files (`ctx.reload()`) — also preserving model + thinking level across the rebuild |
| "context window to N tokens" | edits `models.json` and re-reads it live (`ctx.modelRegistry.refresh()`), no restart needed |

It also registers the matching slash commands for direct TUI use: `/new-chat`, `/reload-runtime`, `/apply-models`.

**Model preservation details:** before `newSession()` / `reload()`, the extension snapshots the current model + thinking level (live `ctx.model` getter, with a fallback to the last `model_change` entry of the session file). After the switch it re-applies them — for `/new-chat` inside the `withSession()` callback bound to the new session, for `/reload-runtime` via a transient state file consumed by the `session_start(reason=reload)` event (the rebuild resets both values to the launch-time ones). A small custom entry (`tg-session-ctl-preserve`) is appended to the old session as a forensic marker; it is never sent to the LLM.

**How it works (the interesting part):** the LLM-callable tool `session_ctl` dispatches its command *immediately* — even mid-turn — by calling

```ts
pi.sendUserMessage("/command", { expandPromptTemplates: true });
```

With `expandPromptTemplates: true`, `session.prompt()` routes any `/command` text through the extension-command dispatcher (full command context, `ctx.reload()` & co.) **instead of delivering it to the model as plain text**. Without that flag the queued command arrives back at the LLM as an ordinary user message and nothing actually runs — which is exactly the trap this extension was built around.

> Built and tested with pi 0.85.x on Windows, used together with
> [pi-telegram](https://github.com/llblab/pi-telegram) by
> [llblab](https://github.com/llblab) — specifically the
> [`@llblab/pi-telegram`](https://www.npmjs.com/package/@llblab/pi-telegram) npm package.
> (There are multiple packages named "pi-telegram" out there; this one targets llblab's.)

## Install

Copy the file into your global extensions folder:

```bash
cp tg-session-ctl.ts ~/.pi/agent/extensions/
```

Then in pi run `/reload` (or, once the extension is active, just ask the agent *"reload"* — nice recursion).

No dependencies beyond what pi already provides (`@earendil-works/pi-coding-agent` types + `typebox`, plus Node built-ins `fs`/`os`/`path`).

## Examples (Windows)

`examples/` contains a double-clickable launcher pair that solves the "ghost windows" problem when starting pi from a `.bat` script:

- **`run-pi.bat`** — kills any existing pi instance before launching a new one, and has no trailing `pause`, so the window closes by itself when pi exits. Re-running the script therefore never accumulates empty windows.
- **`kill-pi.ps1`** — the cleanup step: finds every `node.exe` whose command line contains `pi-coding-agent` and stops it together with its parent `cmd.exe` window.

Copy both next to each other, set your working dir + model in the bat, done.

## Notes

- After dispatching, the tool finishes the turn immediately: a reload / new session replaces the runtime mid-turn, so no further tool calls should happen in the same turn.
- Telegram buttons created before a restart/reload expire ("button action expired") — that is normal bridge behavior; buttons created afterwards work fine.
- Extensions run with your full system permissions; review the code before installing (it is short).
