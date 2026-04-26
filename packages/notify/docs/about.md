# Notify Extension — About

The notify extension (`extensions/notify/`) sends a desktop or terminal notification
when the pi agent finishes working, **but only when the terminal is not the active window**.
This avoids notification noise when you are already watching the output.

## Notification structure

The **title** always carries the project context so you can identify the session at a glance
without reading the body:

```
Pi — myapp (main)
```

The **body** carries the work summary and elapsed time. What goes in the body depends on the mode.

## Notification body modes

Controlled via `PI_NOTIFY_MODE` (default: `smart`).

### `smart` (default)

```
Fixed the login flow · edited auth.ts, server.ts · ran npm test, git commit -m 'fix' · 12s
```

Extracts the first sentence of the agent's final reply, then builds a verbose tool-activity
summary from the calls that ran during the turn:

- **Files:** lists specific basenames (up to 3), then `+N more`
- **Bash:** shows a snippet of each command (≤30 chars, first line), up to 2, then `+N more`;
  failed commands are flagged with `(failed)`

No network requests — all data comes from what pi already has in memory.

### `ai`

```
Refactored JWT validation logic and updated auth test suite · 14s
```

Sends the user's original prompt, the tool-activity summary, and the agent's last reply
snippet to **gpt-5-mini** to produce a crisp, specific one-phrase description of what was
accomplished. Falls back silently to `smart` on any error (missing API key, network
failure, timeout). The request uses a 3-second timeout so failures are fast and invisible.

**Requires:** `OPENAI_API_KEY` set in the environment.

### Configuration

```bash
# Choose a mode
PI_NOTIFY_MODE=smart pi   # default
PI_NOTIFY_MODE=ai    pi

# Persist in your shell profile
export PI_NOTIFY_MODE=ai
```

You can also edit `CONFIG` at the top of `index.ts` to change the default mode,
the OpenAI model (`aiModel`), or the maximum notification body length (`maxBodyLength`).

---

## Focus tracking

Focus is tracked using ANSI focus-event mode (`\x1b[?1004h`). When enabled, the
terminal emits:

- `\x1b[I` — terminal gained focus
- `\x1b[O` — terminal lost focus

The extension assumes focused at session start and updates the state in real time.
Focus tracking is enabled on `session_start` and cleaned up on `session_shutdown`
(including `/reload`, `/fork`, `/new`, and `/resume`).

If a notification is still pending, the extension will try to dismiss it when:

- the terminal regains focus
- a new agent run starts
- the session shuts down

Most modern terminals support this protocol: Kitty, GNOME Terminal, Alacritty,
WezTerm, iTerm2, Windows Terminal, and others.

## Notification backends

Backends are probed once at `session_start`. The first available one is used:

| Priority | Backend | Platform |
|----------|---------|----------|
| 1 | OSC 777 | Terminal in-band (iTerm2, WezTerm, Ghostty, rxvt-unicode) |
| 2 | OSC 99 | Kitty in-band |
| 3 | `powershell.exe` | Windows / WSL (Windows Terminal special case) |

In-band OSC is the preferred default since it works across platforms in modern terminals.
When running inside Windows Terminal (`WT_SESSION`) the extension will use PowerShell
to show a native toast notification.

Dismissal support currently depends on the backend:

- **OSC 99 (Kitty):** explicit close is supported
- **PowerShell / Windows toast:** the extension removes its own toast from notification history
- **OSC 777:** no standard programmatic dismiss is available

> **TODO:** explore additional native backends before falling back to OSC —
> e.g. `kdialog` (KDE), `dunstify` (dunst), `sw-notify` (sway/wlroots),
> `alerter` (macOS).

## Requirements

At least one of the following:

- **Any terminal with OSC support:** (preferred) no install needed — WezTerm, iTerm2, Kitty, rxvt-unicode, etc.
- **Windows/WSL:** `powershell.exe` — used when running inside Windows Terminal (WT_SESSION) for native toasts.
- **`ai` mode only:** `OPENAI_API_KEY` environment variable pointing to an OpenAI key with access to `gpt-5-mini`.

## Install

**Option A — project-local** (already done if you're reading this):
Reference `extensions/notify/index.ts` in `.pi/settings.json`:
```json
{
  "extensions": ["extensions/notify/index.ts"]
}
```

**Option B — global** (works across all projects):
Copy the `notify/` folder to `~/.pi/agent/extensions/notify/` and reference
`extensions/notify/index.ts` in `~/.pi/agent/settings.json`.
