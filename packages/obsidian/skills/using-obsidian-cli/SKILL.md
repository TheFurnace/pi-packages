---
name: Using Obsidian CLI
description: Reads, writes, searches, and manages notes in a running Obsidian vault via the terminal CLI. Use when the user wants to interact with Obsidian notes, tasks, tags, properties, or vault settings from the command line.
---

# Using Obsidian CLI

`obsidian` connects to a running Obsidian instance for scripting, automation, and AI-assisted workflows.

> **Requirement:** Obsidian must be running. Requires Obsidian 1.12.7+ installer with **Settings → General → Command line interface** enabled.

**Full command reference:** [commands.md](commands.md)  
**Installation & troubleshooting:** [troubleshooting.md](troubleshooting.md)  
**TUI keyboard shortcuts:** [tui-shortcuts.md](tui-shortcuts.md)

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

## Common Commands

```shell
# Read / write
obsidian read [file=<name>]
obsidian create name=<name> [content=<text>] [template=<name>] [open] [overwrite]
obsidian append [file=<name>] content=<text>
obsidian prepend [file=<name>] content=<text>
obsidian delete [file=<name>] [permanent]

# Daily note
obsidian daily                              # open
obsidian daily:read                         # read contents
obsidian daily:append content=<text>        # append to today

# Search
obsidian search query=<text> [limit=<n>]
obsidian search:context query=<text>        # grep-style with line context

# Tasks
obsidian tasks [file=<name>] [todo] [done] [verbose]
obsidian task ref="<path>:<line>" [toggle]

# Properties (frontmatter)
obsidian property:read name=<name> [file=<name>]
obsidian property:set name=<name> value=<value> [type=text|list|number|checkbox|date|datetime] [file=<name>]
obsidian property:remove name=<name> [file=<name>]

# Tags
obsidian tags [file=<name>] [counts]
```

For links, outline, templates, vault, plugins, sync, history, bookmarks, publish, and dev commands, see [commands.md](commands.md).

---

## Common Workflows

### Capture a meeting note
```shell
# 1. Create note from template
obsidian create name="2026-04-19 Team Sync" template=Meeting open

# 2. Append agenda items
obsidian append file="2026-04-19 Team Sync" content="## Agenda\n- [ ] Review Q2 goals\n- [ ] Blockers"

# 3. Set status property
obsidian property:set name=status value=draft type=text file="2026-04-19 Team Sync"
```

### Process daily tasks
```shell
# 1. Read today's note
obsidian daily:read

# 2. List all incomplete tasks
obsidian tasks daily todo verbose

# 3. Toggle a task done (use path:line from verbose output)
obsidian task ref="Journal/2026-04-19.md:5" toggle
```

### Search, review, and update
```shell
# 1. Find notes matching a topic
obsidian search query="project phoenix" limit=10

# 2. Read a result
obsidian read file="Project Phoenix Kickoff"

# 3. Mark it reviewed
obsidian property:set name=reviewed value=true type=checkbox file="Project Phoenix Kickoff"
```
