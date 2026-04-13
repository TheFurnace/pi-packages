# Filesystem Sandbox — About

The sandbox extension (`extensions/sandbox/`) enforces filesystem access policy in two layers:

1. **Layer 1 — In-process interception:** `read`, `write`, `edit`, and `bash` tool calls are checked against the path policy before execution.
2. **Layer 2 — bwrap OS enforcement:** bash subprocesses run inside a Linux mount namespace (`bubblewrap`). The kernel enforces the policy regardless of how the shell accesses a file.

## Default policy

| Path | Access |
|------|--------|
| `cwd` (working directory) | read-write |
| `/nix` | read-only |
| Everything else | read-only |

## bwrap hardening

When `bwrap` is available the extension uses:
- `--unshare-pid` + `--proc /proc` — own PID namespace; `/proc/<PID>/root` host-namespace traversal blocked
- `--tmpfs /mnt/wslg` (WSL2 only) — shadows the secondary ext4 rootfs mirror
- Symlink resolution via `realpathSync` — symlinks into inaccessible paths are caught at the real target

If `bwrap` is not found, a warning is shown and Layer 1 continues to operate.

## Known limitations

- **Layer 1 bash scanner** is best-effort — interpreter invocations (`python3 -c`, `perl`, etc.) bypass it; Layer 2 catches these at the OS level.
- **Nix store reads** — committed source files are readable at `/nix/store/<hash>-source/…`; don't commit secrets to a Nix-managed repo.
- **`/sandbox on` double-registration** — calling `/sandbox on` after `/sandbox off` re-registers the bash tool; may produce a warning depending on the pi version.

Full documentation: `docs/sandbox.md`
Audit reports: `docs/sandbox-ctf-findings.md`, `docs/sandbox-ctf2-findings.md`
