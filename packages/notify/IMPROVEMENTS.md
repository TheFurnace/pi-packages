Notify extension — Potential future improvements

Purpose

This document captures possible enhancements and notes for re-introducing
native desktop notification backends if the in-band OSC approach proves
insufficient for desired functionality.

Context

The extension currently prefers in-band OSC notifications (OSC 777 / OSC 99)
for their broad cross-platform availability in modern terminal emulators.
OSC keeps the implementation simple and avoids hard dependencies on external
binaries. However, native backends can provide richer, more persistent, and
interactive notifications in desktop environments.

When to consider re-adding native backends

- Users need actions (buttons) on notifications (e.g. "Open logs", "Dismiss").
- Notifications must persist reliably in the OS notification tray independent
  of terminal scrolling or emulator behavior.
- Images, icons, custom urgency levels, or sounds are required.
- Grouping, replacing, or updating notifications by id is needed.
- Desktop integrations (DE-specific behavior) are important for the project.

Native features that OSC cannot reliably provide

- Action buttons and callbacks.
- Persistent notifications that survive terminal buffers or restarts.
- Fine-grained urgency / timeout controls interop with notification daemons.
- Rich media (icons, images) and structured payloads.
- Integration with desktop-specific features like KDE Action menus.

Design notes for re-introducing native backends

1. Probe strategy
   - Keep OSC-first by default but provide a configurable preference (settings
     option) to prefer native backends when available.
   - Probe once per session_start (as currently done) and cache the chosen
     backend. Allow forcing a different backend via configuration.

2. Detection
   - Avoid brittle heuristics; test for binaries with which/where and verify
     behavior where possible (e.g. run a dry invocation with timeout).
   - For WSL vs native Windows: detect WT_SESSION (Windows Terminal) and use
     powershell to show Windows toasts there. Consider detecting powershell.exe
     availability to optionally use PowerShell when not on WT.

3. Escaping & safety
   - Carefully escape or pass arguments as separate execFile args instead of
     shell interpolation to avoid injection.
   - For backends that only accept a single command string (osascript on macOS
     or PowerShell -Command), ensure proper quoting and limit input size.

4. Backends to consider
   - Linux: dunstify, kdialog, sw-notify (sway/wlroots), notify-send (libnotify)
   - macOS: osascript, possibly alerter or native Objective-C bridge if needed
   - Windows/WSL: powershell.exe / Windows Runtime Toast APIs

5. API surface
   - Extend sendNotification() to accept metadata: icon, urgency, timeout,
     actions (array of {id,label}), replaceId.
   - Provide a graceful fallback to OSC when a native backend doesn't support
     a requested feature (e.g. actions) but OSC can at least show title/body.

6. Testing
   - Add tests or integration verification that run lightweight backend
     probes on CI matrix entries that provide the backend, or run on
     developer machines using environment variables to simulate probes.

7. UX & configuration
   - Expose a user setting: notify.preferred_backends = ["osc","native","powershell"]
   - Allow disabling focus-awareness per user preference.

Security & privacy

- Avoid leaking user content to external programs without escaping.
- Be mindful about long-running child processes; always use timeouts and
  avoid waiting on untrusted input.

Developer notes

- This file is intentionally not listed in package.json "files" so it won't be
  included in the published package. It is meant as a developer-facing guide
  for future enhancements.

Examples & references

- Windows PowerShell toast example is already present in index.ts.
- For Linux, dunstify supports actions and persistency; kdialog can be used
  on KDE; sw-notify is used on some wlroots compositors.
- For macOS, osascript can show notifications but is limited compared to
  native APIs that support actions.

If you want, I can draft an implementation plan to add a selected native
backend (e.g. dunstify or dunst/notify-send) as a configurable fallback,
including the probing logic and API changes to the extension.