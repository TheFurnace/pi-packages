---
name: using-obsidian-cli
description: How to install, configure, and use the Obsidian CLI to control an Obsidian vault from the terminal. Use when the user wants to read, write, search, or manage Obsidian notes, tasks, tags, properties, or vault settings via the command line.
---

# Using Obsidian CLI

Obsidian CLI (`obsidian`) lets you control a running Obsidian instance from the terminal for scripting, automation, and AI-assisted workflows. Anything you can do in the Obsidian app can be done via the CLI.

> **Requirement:** Obsidian must be running. The CLI connects to the live app. Obsidian 1.12 installer (1.12.7+) is required.

---

## Installation

1. Upgrade to the **Obsidian 1.12.7+ installer**.
2. In Obsidian go to **Settings → General** and enable **Command line interface**.
3. Follow the prompt to register the CLI (adds it to your PATH).
4. **Restart your terminal** for PATH changes to take effect.

### Platform notes

| Platform | Registration details |
|----------|----------------------|
| **macOS** | Creates a symlink at `/usr/local/bin/obsidian`. Requires admin prompt. If missing: `sudo ln -sf /Applications/Obsidian.app/Contents/MacOS/obsidian-cli /usr/local/bin/obsidian` |
| **Linux** | Copies binary to `~/.local/bin/obsidian`. Ensure `~/.local/bin` is in `$PATH` (add `export PATH="$PATH:$HOME/.local/bin"` to `~/.bashrc`). |
| **Windows** | Requires Obsidian 1.12.7+ installer. A terminal redirector (`Obsidian.com`) bridges GUI ↔ stdin/stdout. PATH update takes effect after terminal restart. |

---

## Running Commands

### Single command
```shell
obsidian help
obsidian daily
obsidian search query="meeting notes"
```

### Interactive TUI
```shell
obsidian          # launch TUI
help              # then type commands without the "obsidian" prefix
```
The TUI supports autocomplete (`Tab`), command history (`↑`/`↓`), and reverse search (`Ctrl+R`).

---

## Core Concepts

### Parameters and flags
```shell
# Parameter: key=value (quote values with spaces)
obsidian create name=Note content="Hello world"

# Flag: boolean switch, no value needed
obsidian create name=Note open overwrite

# Multiline: use \n and \t
obsidian create name=Note content="# Title\n\nBody text"
```

### Targeting a vault
```shell
# Default: vault matching cwd, or the active vault
obsidian daily

# Explicit vault by name or ID (must be first argument)
obsidian vault=Notes daily
obsidian vault="My Vault" search query="test"
```

### Targeting a file
```shell
# By name (wikilink-style resolution, no extension needed)
obsidian read file=Recipe

# By exact path from vault root
obsidian read path="Templates/Recipe.md"

# Default: active file (when no file/path given)
obsidian read
```

### Copying output
```shell
obsidian read --copy
obsidian search query="TODO" --copy
```

---

## Command Reference

### General
```shell
obsidian help [command]   # list all commands, or help for one
obsidian version          # show Obsidian version
obsidian reload           # reload app window
obsidian restart          # restart app
```

### Files & Folders
```shell
obsidian read [file=<name>] [path=<path>]
obsidian create name=<name> [content=<text>] [template=<name>] [open] [overwrite]
obsidian append [file=<name>] content=<text> [inline]
obsidian prepend [file=<name>] content=<text> [inline]
obsidian move [file=<name>] to=<destination-path>
obsidian rename [file=<name>] name=<new-name>
obsidian delete [file=<name>] [permanent]
obsidian open [file=<name>] [newtab]
obsidian files [folder=<path>] [ext=<ext>] [total]
obsidian folders [folder=<path>] [total]
obsidian file [file=<name>]   # show file metadata
```

### Daily Notes
```shell
obsidian daily                                  # open daily note
obsidian daily:read                             # read contents
obsidian daily:append content=<text> [open]     # append
obsidian daily:prepend content=<text> [open]    # prepend
obsidian daily:path                             # get expected path
```

### Search
```shell
obsidian search query=<text> [path=<folder>] [limit=<n>] [total] [case]
obsidian search:context query=<text>   # grep-style output with line context
obsidian search:open [query=<text>]    # open search panel in app
```

### Tasks
```shell
obsidian tasks [file=<name>] [todo] [done] [daily] [verbose] [total]
obsidian tasks 'status=?'             # filter by custom status char
obsidian task ref="<path>:<line>" [toggle] [done] [todo] [status=<char>]
obsidian task daily line=3 toggle     # toggle task in daily note
```

### Tags
```shell
obsidian tags [file=<name>] [counts] [sort=count] [total] [format=json|tsv|csv]
obsidian tag name=<tag> [verbose] [total]
```

### Properties (Frontmatter)
```shell
obsidian properties [file=<name>] [counts] [format=yaml|json|tsv]
obsidian property:read name=<name> [file=<name>]
obsidian property:set name=<name> value=<value> [type=text|list|number|checkbox|date|datetime] [file=<name>]
obsidian property:remove name=<name> [file=<name>]
```

### Links
```shell
obsidian links [file=<name>] [total]            # outgoing links
obsidian backlinks [file=<name>] [counts] [total]
obsidian unresolved [verbose] [counts] [total]
obsidian orphans [total]                        # files with no incoming links
obsidian deadends [total]                       # files with no outgoing links
```

### Outline & Headings
```shell
obsidian outline [file=<name>] [format=tree|md|json] [total]
```

### Templates
```shell
obsidian templates [total]
obsidian template:read name=<template> [resolve]
obsidian template:insert name=<template>       # insert into active file
obsidian create name=Note template=Travel      # create file from template
```

### Vault & Workspace
```shell
obsidian vault [info=name|path|files|folders|size]
obsidian vaults [verbose] [total]
obsidian workspace                             # show workspace tree
obsidian workspaces [total]
obsidian workspace:save [name=<name>]
obsidian workspace:load name=<name>
obsidian tabs [ids]
obsidian recents [total]
```

### File History & Sync
```shell
obsidian diff [file=<name>] [from=<n>] [to=<n>] [filter=local|sync]
obsidian history [file=<name>]
obsidian history:read [file=<name>] [version=<n>]
obsidian history:restore [file=<name>] version=<n>
obsidian sync [on|off]
obsidian sync:status
obsidian sync:history [file=<name>]
obsidian sync:restore [file=<name>] version=<n>
```

### Plugins
```shell
obsidian plugins [filter=core|community] [versions]
obsidian plugin id=<id>
obsidian plugin:enable id=<id>
obsidian plugin:disable id=<id>
obsidian plugin:install id=<id> [enable]
obsidian plugin:reload id=<id>    # useful during development
```

### Bookmarks
```shell
obsidian bookmarks [verbose] [total] [format=json|tsv|csv]
obsidian bookmark [file=<path>] [url=<url>] [title=<title>]
```

### Publish
```shell
obsidian publish:status [new] [changed] [deleted]
obsidian publish:add [file=<name>] [changed]   # publish file or all changes
obsidian publish:remove [file=<name>]
obsidian publish:list [total]
obsidian publish:open [file=<name>]
```

### Developer Commands
```shell
obsidian eval code="app.vault.getFiles().length"   # run JS in app
obsidian devtools                                   # toggle DevTools
obsidian dev:screenshot path=screenshot.png
obsidian dev:errors [clear]
obsidian dev:console [limit=<n>] [level=log|warn|error] [clear]
obsidian dev:dom selector=<css> [text] [all]
obsidian dev:css selector=<css> [prop=<name>]
obsidian dev:cdp method=<CDP.method> [params=<json>]
obsidian dev:mobile [on|off]
```

---

## Practical Examples

```shell
# Open today's daily note and add a task
obsidian daily
obsidian daily:append content="- [ ] Review PR #42"

# Search and pipe results
obsidian search query="TODO" format=json
obsidian search:context query="FIXME"

# Read a specific note
obsidian read file=MeetingNotes

# Create a note from a template
obsidian create name="2026-04-19 Standup" template=Standup open

# List all incomplete tasks across the vault
obsidian tasks todo verbose

# Set a property on the active file
obsidian property:set name=status value=done type=text

# Compare file versions
obsidian diff file=README from=1 to=3

# Count files in a folder
obsidian files folder=Projects total

# Reload a plugin during development
obsidian plugin:reload id=my-plugin

# Take a screenshot
obsidian dev:screenshot path=~/Desktop/obsidian.png
```

---

## TUI Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Autocomplete / accept suggestion | `Tab` |
| Exit suggestion mode | `Shift+Tab` |
| Accept suggestion at end of line | `→` |
| Previous / next history | `↑` / `↓` |
| Reverse history search | `Ctrl+R` |
| Jump to start / end of line | `Ctrl+A` / `Ctrl+E` |
| Delete to start / end of line | `Ctrl+U` / `Ctrl+K` |
| Delete previous word | `Ctrl+W` |
| Clear screen | `Ctrl+L` |
| Exit TUI | `Ctrl+C` / `Ctrl+D` |

---

## Troubleshooting

- **"obsidian: command not found"** — Restart your terminal; the PATH update only takes effect in a new session.
- **Connection refused / no response** — Obsidian must be running. Launch the app first.
- **After updating Obsidian** — Toggle the CLI setting off and back on to re-register.
- **macOS symlink missing** — Run `sudo ln -sf /Applications/Obsidian.app/Contents/MacOS/obsidian-cli /usr/local/bin/obsidian`
- **Linux binary missing** — Copy from the Obsidian install dir: `cp /path/to/Obsidian/obsidian-cli ~/.local/bin/obsidian && chmod 755 ~/.local/bin/obsidian`
- **Windows** — Requires Obsidian 1.12.7+ installer; the `Obsidian.com` redirector must be present alongside `Obsidian.exe`.
