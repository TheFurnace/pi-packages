# Anthropic Sandbox — Configuration

## Config files (merged, project wins)

| File | Scope |
|------|-------|
| `~/.pi/agent/extensions/anthropic-sandbox.json` | Global — all projects |
| `.pi/anthropic-sandbox.json` | Project-level |

Both files are optional. Project-level values override global ones; unset keys fall back to the built-in defaults.

## Full schema

```json
{
  "enabled": true,
  "network": {
    "allowedDomains": ["github.com", "*.github.com"],
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead":   ["~/.ssh", "~/.aws", "~/.gnupg"],
    "allowWrite": [".", "/tmp"],
    "denyWrite":  [".env", ".env.*", "*.pem", "*.key"]
  },
  "ignoreViolations": {},
  "enableWeakerNestedSandbox": false
}
```

## Field reference

### `enabled`
`boolean` — Set to `false` to disable the sandbox without removing the extension. Default: `true`.

### `network.allowedDomains`
`string[]` — Domains (and subdomains via `*` wildcard) that outbound connections are permitted to reach. Connections to any other domain are blocked.

### `network.deniedDomains`
`string[]` — Explicit denylist. Takes precedence over `allowedDomains`.

### `filesystem.denyRead`
`string[]` — Paths that cannot be read inside the sandbox. `~` expands to `$HOME`.

### `filesystem.allowWrite`
`string[]` — Paths where writes are permitted. Everything outside this list is read-only. `.` resolves to the session `cwd`.

### `filesystem.denyWrite`
`string[]` — Glob patterns / paths that must never be written, even if they fall inside an `allowWrite` directory. Useful for protecting secrets files inside the project root.

### `ignoreViolations`
`Record<string, string[]>` — Advanced: tell the runtime to silently ignore specific violation categories. Consult `@anthropic-ai/sandbox-runtime` docs for valid keys.

### `enableWeakerNestedSandbox`
`boolean` — Set to `true` when running inside an existing sandbox (e.g. CI, Docker). Default: `false`.

## CLI flag

```bash
pi -e anthropic-sandbox --no-sandbox   # load extension but skip initialization
```

## Runtime command

```
/sandbox    — print active configuration and status
```

## Default allowed domains

```
npmjs.org, *.npmjs.org, registry.npmjs.org
registry.yarnpkg.com
pypi.org, *.pypi.org
github.com, *.github.com, api.github.com, raw.githubusercontent.com
```
