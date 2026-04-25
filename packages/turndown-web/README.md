# @pi-agent/turndown-web

Adds a `read_website` tool to pi.

## What it does

- fetches an HTTP(S) page
- supports three clearly named modes:
  - `page` - the sensible default for most web-reading tasks
  - `navigation` - focuses on nav/header/footer/aside content and grouped links
  - `links` - returns only extracted links
- in `page` mode, prefers `<main>`, `<article>`, or `<body>` when present, then falls back more broadly when the result is too thin
- adds a compact `Key links` section in `page` mode when a page is light on prose
- converts body links to absolute URLs
- strips boilerplate like `script`, `style`, and other non-readable elements
- converts the remaining HTML to Markdown with [Turndown](https://github.com/mixmark-io/turndown)
- enables GitHub-Flavored Markdown rules via `turndown-plugin-gfm`

## Install

```bash
pi install /home/agents/repos/pi-packages/packages/turndown-web
```

Or from a git-hosted copy of this repo:

```bash
pi install git:github.com/TheFurnace/pi-packages
```

If you install the whole repo, use package filtering in `settings.json` to enable only `packages/turndown-web/*` if desired.

## Tool

### `read_website`

Parameters:

- `url` - HTTP or HTTPS URL. If the scheme is omitted, `https://` is assumed.
- `mode` - optional. `page`, `navigation`, or `links`. Defaults to `page`.
- `linkScope` - optional. `all`, `internal`, or `external`. Defaults to `all`. Used in `navigation` and `links` modes.
- `sameSiteOnly` - optional. When `true`, only keeps links on the same site as the fetched page. Used in `navigation` and `links` modes.
- `maxCharacters` - optional output cap. Defaults to `20000`.
- `preferMainContent` - optional. Defaults to `true`. Used in `page` mode.

## Suggested usage

Use the default `page` mode when you want pi to read or summarize a page.

Use `navigation` when you want site structure, menus, or grouped navigational content.

Use `links` when you only want URLs and labels.

## Example prompts

- "Use `read_website` on https://example.com and summarize it."
- "Fetch docs at docs.astral.sh with `read_website`."
- "Read https://example.com/blog/post and quote the important parts."
- "Use `read_website` with mode `navigation` on https://example.com and list the site links."
- "Pull the navigation structure from https://docs.astral.sh using `read_website` in navigation mode."
- "Use `read_website` with mode `links` on https://example.com."
- "Get only internal links from https://docs.astral.sh with `read_website` using mode `links` and `linkScope` set to `internal`."
- "Use `read_website` in navigation mode and keep only same-site links."
