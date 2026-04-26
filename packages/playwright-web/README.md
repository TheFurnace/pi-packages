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

**If you are using the `pi-flake` NixOS module** (the recommended way to run pi on NixOS), this is already wired up for you — `playwright-driver.browsers` is included in the pi user's packages and `PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH` is set in both `pi-run` and `home.sessionVariables`. After running `sudo nixos-rebuild switch`, the extension works with no further configuration.

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
