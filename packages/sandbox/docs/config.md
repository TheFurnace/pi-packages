# Filesystem Sandbox — Configuration

## Config files (merged, project wins)

| File | Scope |
|------|-------|
| `~/.pi/agent/sandbox.json` | Global — all projects |
| `.pi/sandbox.json` | Project-level |

```json
{
  "enabled": true,
  "stealthErrors": false,
  "paths": [
    { "path": ".",        "access": "read-write"   },
    { "path": "/tmp",     "access": "read-write"   },
    { "path": "~/.ssh",   "access": "inaccessible" },
    { "path": ".env",     "access": "inaccessible" }
  ]
}
```

## Access levels

| Value | Effect |
|-------|--------|
| `"read-write"` | Full read and write access |
| `"read-only"` | Reads allowed, writes blocked |
| `"inaccessible"` | All access denied; appears as empty dir in bash |

Path resolution: `~` → `$HOME`, relative paths resolve from `cwd`, symlinks are followed,
longest match wins, unmatched paths default to `read-only`.

## `stealthErrors`

When `true`, blocked-access messages look like natural OS errors:
- Read blocked → `<path>: No such file or directory`
- Write blocked → `<path>: Read-only file system`

## Toggle

```bash
pi --no-sandbox        # disable for this session
/sandbox on            # re-enable at runtime
/sandbox off           # disable at runtime
/sandbox               # show status and active policy
```
