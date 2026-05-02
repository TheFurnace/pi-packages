# playwright-web

A pi extension that provides a `read_website_browser` tool — a headless-Chromium-powered counterpart to `read_website` from the `turndown-web` package. It is designed for pages that require JavaScript execution to render their content: Single Page Applications (React, Vue, Svelte), Obsidian Publish sites, GitBook, and any other dynamically rendered documentation platform.

## When to use this vs `read_website`

| Scenario | Tool |
|---|---|
| Static HTML page, blog post, docs site | `read_website` (faster, no browser overhead) |
| SPA / JavaScript-rendered page | `read_website_browser` |
| `read_website` returns empty content | `read_website_browser` |
| Need the fully-rendered HTML source | `read_website_browser` with `mode: "raw"` |

## Browser binary resolution

All binaries are managed by Playwright — no system browser is used or required. On first use of a given browser, the tool downloads its Playwright-pinned binary programmatically via `playwright-core`'s internal registry API (no CLI, no npx). The binary is cached in `~/.cache/ms-playwright/` and reused on subsequent calls.

If the download fails, the tool throws a clear error with a manual installation command.

### NixOS

Playwright's downloaded binaries are generic ELF executables that can't run on NixOS. The correct solution is to use the `playwright-driver.browsers` package from nixpkgs, which provides NixOS-patched binaries, and point the extension at them via an environment variable.

**If you are using the `pi-flake` NixOS module** (the recommended way to run pi on NixOS), this is already wired up for you — `playwright-driver.browsers` is added to `environment.systemPackages` and `PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH` is set via `environment.variables` (system-wide, covering all users) and explicitly in `pi-run`. After running `sudo nixos-rebuild switch`, the extension works for any user on the machine with no further configuration.

**If you are running pi outside the NixOS module**, set the following before starting pi:

```bash
# Determine the chromium revision bundled with your nixpkgs playwright-driver
DRIVER=$(nix-build '<nixpkgs>' -A playwright-driver --no-out-link)
BROWSERS=$(nix-build '<nixpkgs>' -A playwright-driver.browsers --no-out-link)
REV=$(python3 -c "import json; d=json.load(open('$DRIVER/browsers.json')); print(next(b['revision'] for b in d['browsers'] if b['name']=='chromium'))")

export PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH="$BROWSERS/chromium-$REV/chrome-linux64/chrome"
export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
```

> **Version note:** the `playwright-driver` version in your nixpkgs channel must match the major and minor version of the `playwright` npm package bundled with this extension. Check with:
> ```bash
> nix-instantiate --eval -E '(import <nixpkgs> {}).playwright-driver.version'
> ```
> If there is a mismatch, pin nixpkgs to a commit where the versions align, or update the `playwright` dependency in this package.

## `read_website_browser` parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `url` | string | required | HTTP/HTTPS URL to fetch |
| `mode` | string | `"page"` | `"page"` \| `"navigation"` \| `"links"` \| `"raw"` |
| `browser` | string | `"chromium"` | `"chromium"` \| `"firefox"` \| `"webkit"` |
| `linkScope` | string | `"all"` | `"all"` \| `"internal"` \| `"external"` |
| `sameSiteOnly` | boolean | `false` | Restrict links to same site |
| `maxCharacters` | integer | `20000` | Max characters to return (cap: 100000) |
| `preferMainContent` | boolean | `true` | Prefer `<main>`/`<article>` over full body |

## Modes

- **`page`** — Extracts the main readable content and converts it to Markdown via Turndown.
- **`navigation`** — Extracts `<nav>`, `<header>`, `<aside>`, `<footer>` sections and their links.
- **`links`** — Returns all links as a Markdown list, optionally filtered by scope.
- **`raw`** — Returns the fully-rendered HTML source as-is. Useful for inspecting embedded JSON (`window.__STATE__` etc.) or discovering internal API endpoints in SPA shells.

## Local web development tools

In addition to `read_website_browser`, this package provides persistent browser-session tools for testing local web apps after an agent starts a dev server with normal shell commands.

Recommended workflow:

1. Start the app server, for example:
   ```bash
   npm run dev -- --host 127.0.0.1 > /tmp/app.log 2>&1 & echo $!
   ```
2. Open the app with `browser_open`, for example `http://127.0.0.1:5173`.
3. Inspect the UI with `browser_snapshot`.
4. Interact with the UI using `browser_interact`.
5. Debug with `browser_logs` and `browser_screenshot`.
6. Close the session with `browser_close` when finished.

### Tools

| Tool | Purpose |
|---|---|
| `browser_open` | Open a URL in a persistent browser session and return a `sessionId`. Defaults local-development navigation to `domcontentloaded`. Supports `viewport`, `deviceScaleFactor`, `mobile`, and `hasTouch` for mobile-style testing. |
| `browser_snapshot` | Return current URL/title, visible interactive elements, and visible text. Optional modes: `visible-elements`, `text`, `html`, `accessibility` alias. |
| `browser_interact` | Perform `click`, `fill`, `type`, `press`, `select`, `check`, `uncheck`, or `hover`. Prefer accessible locators: role/name, label, placeholder, testId. |
| `browser_logs` | Read captured console messages, page errors, failed requests, and HTTP 4xx/5xx responses. |
| `browser_screenshot` | Save a PNG screenshot to `/tmp/pi-playwright-web/<sessionId>/` unless a path is provided. |
| `browser_wait` | Wait for load states, visible selectors/text, URL changes, or a fixed timeout. Prefer specific selector/text waits over sleeps. |
| `browser_eval` | Execute bounded JavaScript in the page for advanced debugging when snapshots are insufficient. |
| `browser_assert` | Run lightweight UI assertions for visible/hidden text or selectors, URL matches, and title matches. |
| `browser_close` | Close a persistent browser session. |
| `browser_list_sessions` | List currently active browser sessions. |

### Localhost URL normalization

The interactive tools are optimized for dev servers:

| Input | Normalized URL |
|---|---|
| `localhost:5173` | `http://localhost:5173` |
| `127.0.0.1:5173` | `http://127.0.0.1:5173` |
| `0.0.0.0:5173` | `http://0.0.0.0:5173` |
| `example.com` | `https://example.com` |

`read_website_browser` keeps its existing HTTP(S) reader behavior and should still be used for content extraction from remote websites and documentation. Use the `browser_*` tools for interactive local app testing.

### Mobile-style sessions

For mobile-style testing with the interactive browser tools, pass a phone-sized viewport and optionally enable Playwright's mobile and touch flags:

```json
{
  "url": "http://127.0.0.1:5173",
  "viewport": { "width": 390, "height": 844 },
  "deviceScaleFactor": 3,
  "mobile": true,
  "hasTouch": true
}
```

This is lighter-weight than full named-device presets, but useful for responsive and touch-oriented UI checks.

### Lifecycle and cleanup

Interactive browser sessions are in-memory state inside the current Pi extension runtime.

- `browser_close` closes a session's Playwright context and releases its reference to the shared browser process.
- Idle sessions auto-close after 10 minutes of inactivity.
- Pi `session_shutdown` events (`/reload`, `/new`, `/resume`, `/fork`, and normal quit) close all persistent sessions and pooled browser processes for the old extension runtime.
- If the Pi process is force-killed (`SIGKILL`, crash, power loss), no JavaScript cleanup handler can run. Playwright child processes are normally tied to the parent process, but orphan cleanup is ultimately the operating system's responsibility.
- Screenshot artifacts under `/tmp/pi-playwright-web/<sessionId>/` are not deleted automatically.

## Install

```
pi install /path/to/pi-packages/packages/playwright-web
```
