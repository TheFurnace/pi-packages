# Full Command Reference

## Contents
- [General](#general)
- [Files & Folders](#files--folders)
- [Daily Notes](#daily-notes)
- [Search](#search)
- [Tasks](#tasks)
- [Tags](#tags)
- [Properties](#properties-frontmatter)
- [Links](#links)
- [Outline & Headings](#outline--headings)
- [Templates](#templates)
- [Vault & Workspace](#vault--workspace)
- [File History & Sync](#file-history--sync)
- [Plugins](#plugins)
- [Bookmarks](#bookmarks)
- [Publish](#publish)
- [Developer Commands](#developer-commands)

---

## General
```shell
obsidian help [command]   # list all commands, or help for one
obsidian version          # show Obsidian version
obsidian reload           # reload app window
obsidian restart          # restart app
```

## Files & Folders
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

## Daily Notes
```shell
obsidian daily                                  # open daily note
obsidian daily:read                             # read contents
obsidian daily:append content=<text> [open]     # append
obsidian daily:prepend content=<text> [open]    # prepend
obsidian daily:path                             # get expected path
```

## Search
```shell
obsidian search query=<text> [path=<folder>] [limit=<n>] [total] [case]
obsidian search:context query=<text>   # grep-style output with line context
obsidian search:open [query=<text>]    # open search panel in app
```

## Tasks
```shell
obsidian tasks [file=<name>] [todo] [done] [daily] [verbose] [total]
obsidian tasks 'status=?'             # filter by custom status char
obsidian task ref="<path>:<line>" [toggle] [done] [todo] [status=<char>]
obsidian task daily line=3 toggle     # toggle task in daily note
```

## Tags
```shell
obsidian tags [file=<name>] [counts] [sort=count] [total] [format=json|tsv|csv]
obsidian tag name=<tag> [verbose] [total]
```

## Properties (Frontmatter)
```shell
obsidian properties [file=<name>] [counts] [format=yaml|json|tsv]
obsidian property:read name=<name> [file=<name>]
obsidian property:set name=<name> value=<value> [type=text|list|number|checkbox|date|datetime] [file=<name>]
obsidian property:remove name=<name> [file=<name>]
```

## Links
```shell
obsidian links [file=<name>] [total]            # outgoing links
obsidian backlinks [file=<name>] [counts] [total]
obsidian unresolved [verbose] [counts] [total]
obsidian orphans [total]                        # files with no incoming links
obsidian deadends [total]                       # files with no outgoing links
```

## Outline & Headings
```shell
obsidian outline [file=<name>] [format=tree|md|json] [total]
```

## Templates
```shell
obsidian templates [total]
obsidian template:read name=<template> [resolve]
obsidian template:insert name=<template>       # insert into active file
obsidian create name=Note template=Travel      # create file from template
```

## Vault & Workspace
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

## File History & Sync
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

## Plugins
```shell
obsidian plugins [filter=core|community] [versions]
obsidian plugin id=<id>
obsidian plugin:enable id=<id>
obsidian plugin:disable id=<id>
obsidian plugin:install id=<id> [enable]
obsidian plugin:reload id=<id>    # useful during development
```

## Bookmarks
```shell
obsidian bookmarks [verbose] [total] [format=json|tsv|csv]
obsidian bookmark [file=<path>] [url=<url>] [title=<title>]
```

## Publish
```shell
obsidian publish:status [new] [changed] [deleted]
obsidian publish:add [file=<name>] [changed]   # publish file or all changes
obsidian publish:remove [file=<name>]
obsidian publish:list [total]
obsidian publish:open [file=<name>]
```

## Developer Commands
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
