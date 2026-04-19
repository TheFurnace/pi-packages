# Installation & Troubleshooting

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

## Troubleshooting

- **"obsidian: command not found"** — Restart your terminal; the PATH update only takes effect in a new session.
- **Connection refused / no response** — Obsidian must be running. Launch the app first.
- **After updating Obsidian** — Toggle the CLI setting off and back on to re-register.
- **macOS symlink missing** — Run `sudo ln -sf /Applications/Obsidian.app/Contents/MacOS/obsidian-cli /usr/local/bin/obsidian`
- **Linux binary missing** — Copy from the Obsidian install dir: `cp /path/to/Obsidian/obsidian-cli ~/.local/bin/obsidian && chmod 755 ~/.local/bin/obsidian`
- **Windows** — Requires Obsidian 1.12.7+ installer; the `Obsidian.com` redirector must be present alongside `Obsidian.exe`.
