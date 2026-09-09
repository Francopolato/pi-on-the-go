# pi-on-the-go

Control your [pi](https://github.com/earendil-works/pi) coding agent from anywhere — for example over **Telegram**, while you are away from the machine. No desktop, no remote-desktop session: just a chat message.

This repository contains custom [pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) designed for **remote use**: the agent exposes session-control actions as tools it can trigger on its own, so a single message from your phone is enough.

## Extensions

### `tg-session-ctl.ts` — session control from Telegram

Lets you (via chat) manage the pi session without touching a keyboard:

| You say / type | What happens |
|---|---|
| "new chat" / "nuova chat" | starts a brand-new empty session (`ctx.newSession()`) |
| "reload" | full runtime reload — extensions, skills, prompts, themes, context files (`ctx.reload()`) |
| "context window to N tokens" | edits `models.json` and re-reads it live (`ctx.modelRegistry.refresh()`), no restart needed |

It also registers the matching slash commands for direct TUI use: `/new-chat`, `/reload-runtime`, `/apply-models`.

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

No dependencies beyond what pi already provides (`@earendil-works/pi-coding-agent` types + `typebox`).

## Notes

- After dispatching, the tool finishes the turn immediately: a reload / new session replaces the runtime mid-turn, so no further tool calls should happen in the same turn.
- Telegram buttons created before a restart/reload expire ("button action expired") — that is normal bridge behavior; buttons created afterwards work fine.
- Extensions run with your full system permissions; review the code before installing (it is short).
