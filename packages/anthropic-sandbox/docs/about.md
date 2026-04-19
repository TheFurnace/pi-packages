# Anthropic Sandbox — About

The `anthropic-sandbox` extension enforces network and filesystem access policy using [`@anthropic-ai/sandbox-runtime`](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime) — Anthropic's official OS-level sandbox library.

## How it works

Every agent `bash` tool call and user-initiated shell command (`!` in the TUI) is wrapped by `SandboxManager.wrapWithSandbox()` before execution. The runtime translates the policy into native OS primitives:

| Platform | Mechanism |
|----------|-----------|
| macOS    | `sandbox-exec` (Seatbelt) |
| Linux    | `bubblewrap` (`bwrap`) mount namespaces |

## What is enforced

### Network
Outbound connections are filtered by domain allowlist / denylist. Connections to domains not on the allowlist are blocked at the OS level.

### Filesystem
- **`denyRead`** — paths the sandbox cannot read
- **`allowWrite`** — paths the sandbox may write to (everything else is read-only)
- **`denyWrite`** — specific paths or globs that must never be written, even inside `allowWrite` directories

## Default policy

| Category | Default |
|----------|---------|
| Network allowlist | Common package registries (npm, PyPI) + GitHub |
| Network denylist | *(empty)* |
| Deny read | `~/.ssh`, `~/.aws`, `~/.gnupg` |
| Allow write | `.` (cwd), `/tmp` |
| Deny write | `.env`, `.env.*`, `*.pem`, `*.key` |

## Relation to the `sandbox` package

The repo also contains a `sandbox` package that implements a similar policy using a hand-rolled `bwrap` integration and an in-process Layer 1 interceptor for `read`/`write`/`edit` tool calls.

`anthropic-sandbox` trades Layer 1 tool interception for a simpler, officially-supported runtime that Anthropic maintains. Choose based on your needs:

| Feature | `sandbox` | `anthropic-sandbox` |
|---------|-----------|----------------------|
| Layer 1 (in-process tool check) | ✓ | ✗ |
| Layer 2 (OS enforcement on bash) | ✓ (bwrap, manual) | ✓ (via SDK) |
| Network filtering | ✗ | ✓ |
| macOS support | ✗ | ✓ |
| Maintained by Anthropic | ✗ | ✓ |

## Known limitations

- Only `bash` tool calls are sandboxed. `read`/`write`/`edit` tool calls are **not** intercepted at the in-process layer — if you need that, combine with the `sandbox` extension's Layer 1 or use the `sandbox` package instead.
- `enableWeakerNestedSandbox` is required when running inside an already-sandboxed environment (e.g. CI).
- Linux requires `bubblewrap`, `socat`, and `ripgrep` to be installed.
