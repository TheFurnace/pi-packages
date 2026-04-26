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

Playwright's downloaded binaries are generic ELF executables that can't run on NixOS. The NixOS community solution is to use `playwright-driver.browsers` from nixpkgs and point the tool at those patched binaries via an environment variable.

Set **one** of the following before starting pi:

```bash
# Generic fallback (NixOS community convention, applies to all browsers)
export PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH="$(nix-build '<nixpkgs>' -A playwright-driver.browsers --no-out-link)/chromium-$(nix-instantiate --eval -E '(builtins.fromJSON (builtins.readFile "'$(nix-build '<nixpkgs>' -A playwright-driver --no-out-link)'/browsers.json")).browsers' | python3 -c 'import sys,json; print(next(b["revision"] for b in json.loads(sys.stdin.read()) if b["name"]=="chromium"))')/chrome-linux64/chrome"

# Or, simpler — hardcode the path once you know it:
export PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH=/nix/store/<hash>-playwright-browsers/chromium-<rev>/chrome-linux64/chrome

# Per-browser variants (take priority over the generic one):
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome
export PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH=/path/to/firefox
export PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH=/path/to/webkit
```

> **Note:** The nixpkgs `playwright-driver` version must match (major + minor) the `playwright` npm package version bundled with this extension. Check with `nix-instantiate --eval -E '(import <nixpkgs> {}).playwright-driver.version'`.

## Parameters

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

## Install

```
pi install /path/to/pi-packages/packages/playwright-web
```
