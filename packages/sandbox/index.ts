/**
 * Filesystem Sandbox Extension for pi-agent
 *
 * Enforces filesystem access policy via two layers:
 *   1. tool_call interception — blocks read/write/edit/bash before execution
 *   2. bwrap OS enforcement  — wraps bash subprocesses in a mount namespace
 *
 * Config files (merged, project overrides global):
 *   ~/.pi/agent/sandbox.json   — global defaults
 *   .pi/sandbox.json           — project-level policy
 *
 * Example .pi/sandbox.json:
 * ```json
 * {
 *   "enabled": true,
 *   "paths": [
 *     { "path": ".",      "access": "read-write"   },
 *     { "path": "/tmp",   "access": "read-write"   },
 *     { "path": "~/.ssh", "access": "inaccessible" },
 *     { "path": ".env",   "access": "inaccessible" }
 *   ]
 * }
 * ```
 *
 * Toggle:
 *   pi --no-sandbox       — disable for this session
 *   /sandbox [on|off]     — toggle at runtime
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool, getAgentDir, isToolCallEventType, type BashOperations } from "@mariozechner/pi-coding-agent";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Types ────────────────────────────────────────────────────────────────────

type Access = "read-write" | "read-only" | "inaccessible";

interface PathRule {
  path: string;
  access: Access;
}

interface SandboxConfig {
  enabled?: boolean;
  paths?: PathRule[];
  /** Replace [sandbox] block messages with natural-looking OS errors */
  stealthErrors?: boolean;
}

interface ResolvedRule {
  resolved: string; // absolute path
  access: Access;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  paths: [],
};

const INITIAL_PROJECT_CONFIG: SandboxConfig = {
  enabled: true,
  paths: [],
};

function loadConfig(cwd: string): SandboxConfig {
  const globalPath = join(getAgentDir(), "sandbox.json");
  const projectPath = join(cwd, ".pi", "sandbox.json");

  let global: SandboxConfig = {};
  let project: SandboxConfig = {};

  if (existsSync(globalPath)) {
    try { global = JSON.parse(readFileSync(globalPath, "utf-8")); } catch {}
  }

  if (existsSync(projectPath)) {
    try { project = JSON.parse(readFileSync(projectPath, "utf-8")); } catch {}
  } else {
    // Auto-write default project config on first run
    try {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(projectPath, JSON.stringify(INITIAL_PROJECT_CONFIG, null, 2) + "\n");
    } catch {}
  }

  return {
    enabled: project.enabled ?? global.enabled ?? DEFAULT_CONFIG.enabled,
    paths: [...(global.paths ?? []), ...(project.paths ?? [])],
  };
}

// ─── Policy Resolution ────────────────────────────────────────────────────────

function resolveRules(config: SandboxConfig, cwd: string): ResolvedRule[] {
  const rules: ResolvedRule[] = [
    // Implicit defaults (lowest priority — user rules override)
    { resolved: cwd,         access: "read-write" },
    // Nix store is always read-only — prevents store-copy escape where committed
    // source files are accessible at /nix/store/<hash>-source/<path>
    { resolved: "/nix",      access: "read-only"  },
  ];

  for (const rule of config.paths ?? []) {
    const expanded = rule.path.replace(/^~/, homedir());
    rules.push({ resolved: resolve(cwd, expanded), access: rule.access });
  }

  // Sort longest-first so most-specific rule wins
  return rules.sort((a, b) => b.resolved.length - a.resolved.length);
}

function getAccess(absPath: string, rules: ResolvedRule[]): Access {
  for (const rule of rules) {
    if (absPath === rule.resolved || absPath.startsWith(rule.resolved + "/")) {
      return rule.access;
    }
  }
  return "read-only"; // default for everything outside cwd
}

function resolvePath(p: string, cwd: string): string {
  const logical = resolve(cwd, p.replace(/^@/, "").replace(/^~/, homedir()));
  // Follow symlinks so a link in /tmp pointing to an inaccessible path
  // is evaluated against the real target, not the symlink location.
  // Fall back to the logical path if the target doesn't exist yet.
  try { return realpathSync(logical); } catch { return logical; }
}

// ─── Layer 1 helpers ──────────────────────────────────────────────────────────

function checkRead(path: string, cwd: string, rules: ResolvedRule[], stealth = false): string | null {
  const abs = resolvePath(path, cwd);
  const access = getAccess(abs, rules);
  if (access === "inaccessible") return stealth
    ? `${abs}: No such file or directory`
    : `[sandbox] read blocked: ${abs} is inaccessible`;
  return null;
}

function checkWrite(path: string, cwd: string, rules: ResolvedRule[], stealth = false): string | null {
  const abs = resolvePath(path, cwd);
  const access = getAccess(abs, rules);
  if (access === "inaccessible") return stealth
    ? `${abs}: No such file or directory`
    : `[sandbox] write blocked: ${abs} is inaccessible`;
  if (access === "read-only") return stealth
    ? `${abs}: Read-only file system`
    : `[sandbox] write blocked: ${abs} is read-only`;
  return null;
}

// Best-effort bash command path scanner
// Catches redirects (> >>), common commands (cat, cp, mv, rm, touch, echo > ...)
const WRITE_CMD_RE = /(?:>>?|tee(?:\s+-a)?)\s+([^\s;|&]+)/g;
const READ_CMD_RE  = /(?:^|\|\s*|;\s*|&&\s*|\|\|\s*)(?:cat|head|tail|grep|less|more|wc)\s+([^\s;|&>]+)/g;

function scanBashPaths(command: string, cwd: string, rules: ResolvedRule[]): string | null {
  for (const match of command.matchAll(WRITE_CMD_RE)) {
    const p = match[1];
    if (p.startsWith("-")) continue;
    const err = checkWrite(p, cwd, rules);
    if (err) return err + " (detected in bash command)";
  }
  for (const match of command.matchAll(READ_CMD_RE)) {
    const p = match[1];
    if (p.startsWith("-")) continue;
    const err = checkRead(p, cwd, rules);
    if (err) return err + " (detected in bash command)";
  }
  return null;
}

// ─── Layer 2: bwrap ───────────────────────────────────────────────────────────

function detectBwrap(): string | null {
  try {
    const out = execFileSync("which", ["bwrap"], { encoding: "utf-8" }).trim();
    return out || null;
  } catch { return null; }
}

function buildBwrapArgs(rules: ResolvedRule[], cwd: string): string[] {
  const args: string[] = [
    "--ro-bind", "/", "/",   // whole FS read-only
    "--dev", "/dev",
    "--proc", "/proc",
    "--unshare-pid",           // own PID namespace — /proc only shows sandbox procs,
                               // closing the /proc/<PID>/root host-namespace escape
    // WSL2 exposes the Linux rootfs as a second mirror at /mnt/wslg/distro/
    // via a separate ext4 mount of /dev/sdd. Shadow it with an empty tmpfs
    // so inaccessible paths can't be reached through the mirror.
    ...(existsSync("/mnt/wslg") ? ["--tmpfs", "/mnt/wslg"] : []),
  ];

  // Apply rules least-specific first so more-specific ones override
  const sorted = [...rules].sort((a, b) => a.resolved.length - b.resolved.length);

  for (const rule of sorted) {
    const p = rule.resolved;
    if (rule.access === "read-write") {
      args.push("--bind", p, p);
    } else if (rule.access === "inaccessible") {
      args.push("--tmpfs", p);
    }
    // read-only: already covered by --ro-bind / at the top
  }

  return args;
}

function createSandboxedBashOps(bwrapPath: string, bwrapArgs: string[]): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      return new Promise((resolve, reject) => {
        const child = spawn(
          bwrapPath,
          [...bwrapArgs, "--chdir", cwd, "--", "bash", "-c", command],
          { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] },
        );

        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        if (timeout && timeout > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
          }, timeout * 1000);
        }

        const kill = () => {
          try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        };

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("error", (err) => { if (timer) clearTimeout(timer); reject(err); });
        signal?.addEventListener("abort", kill, { once: true });

        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", kill);
          if (signal?.aborted) return reject(new Error("aborted"));
          if (timedOut)        return reject(new Error(`timeout:${timeout}`));
          resolve({ exitCode: code ?? 1 });
        });
      });
    },
  };
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", {
    description: "Disable filesystem sandbox for this session",
    type: "boolean",
    default: false,
  });

  let enabled     = false;
  let rules:      ResolvedRule[] = [];
  let bwrapPath:  string | null  = null;
  let sessionCwd  = process.cwd();
  let stealth     = false;

  // ── session_start ──────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd;

    if (pi.getFlag("no-sandbox") as boolean) {
      enabled = false;
      ctx.ui.notify("[sandbox] disabled via --no-sandbox", "warning");
      ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("warning", "⚠ sandbox: off"));
      return;
    }

    const config = loadConfig(ctx.cwd);

    if (!config.enabled) {
      enabled = false;
      ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("warning", "⚠ sandbox: off"));
      return;
    }

    rules     = resolveRules(config, ctx.cwd);
    bwrapPath = detectBwrap();
    stealth   = config.stealthErrors ?? false;
    enabled   = true;

    // Register sandboxed bash tool
    applyBashOverride(ctx.cwd, ctx);

    const rwCount = rules.filter(r => r.access === "read-write").length;
    const noCount = rules.filter(r => r.access === "inaccessible").length;
    const bwrapNote = bwrapPath ? "" : " (bwrap not found — layer 2 disabled)";

    ctx.ui.setStatus(
      "sandbox",
      ctx.ui.theme.fg("accent", `🔒 sandbox: ${rwCount} rw, ${noCount} blocked${bwrapNote}`),
    );

    if (!bwrapPath) {
      ctx.ui.notify("[sandbox] bwrap not found — OS enforcement unavailable, using in-process policy only", "warning");
    }
  });

  // ── before_agent_start: inject writable-path context into system prompt ────

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!enabled || rules.length === 0) return;

    const rwPaths      = [...new Set(rules.filter(r => r.access === "read-write").map(r => r.resolved))];
    const blockedPaths = [...new Set(rules.filter(r => r.access === "inaccessible").map(r => r.resolved))];

    const docsDir = join(__dirname, "docs");
    const lines = [
      "",
      "## Sandbox: Filesystem Write Restrictions",
      "",
      "The filesystem sandbox is active. Writable paths:",
      ...rwPaths.map(p => `- \`${p}\``),
      "",
      "All other paths are read-only. Writes outside the listed paths will fail immediately.",
      ...(blockedPaths.length > 0
        ? ["", "Inaccessible paths (cannot read or write):", ...blockedPaths.map(p => `- \`${p}\``)]
        : []
      ),
      "",
      "If asked — directly or implicitly — to write outside the writable paths:",
      "1. Do NOT attempt the write — it will be blocked",
      "2. Tell the user: \"Write access to `<path>` is not available in the sandbox. Only the listed paths are writable.\"",
      "3. Suggest granting elevated access or performing the change outside the agent",
      "",
      `For sandbox configuration and usage documentation, see: \`${docsDir}/\``,
    ];

    return { systemPrompt: event.systemPrompt + lines.join("\n") };
  });

  // ── Layer 1: tool_call interception ───────────────────────────────────────

  pi.on("tool_call", async (event, _ctx) => {
    if (!enabled) return;

    if (isToolCallEventType("read", event)) {
      const err = checkRead(event.input.path, sessionCwd, rules, stealth);
      if (err) return { block: true, reason: err };
    }

    if (isToolCallEventType("write", event)) {
      const err = checkWrite(event.input.path, sessionCwd, rules, stealth);
      if (err) return { block: true, reason: err };
    }

    if (isToolCallEventType("edit", event)) {
      const err = checkWrite(event.input.path, sessionCwd, rules, stealth);
      if (err) return { block: true, reason: err };
    }

    if (isToolCallEventType("bash", event)) {
      const err = scanBashPaths(event.input.command, sessionCwd, rules);
      if (err) return { block: true, reason: err };
    }
  });

  // ── Layer 2: bwrap bash override ──────────────────────────────────────────

  function applyBashOverride(cwd: string, ctx: { ui: { notify: (msg: string, t: string) => void } }) {
    if (!bwrapPath || !enabled) return;

    const bwrapArgs = buildBwrapArgs(rules, cwd);
    const localBash = createBashTool(cwd);

    pi.registerTool({
      ...localBash,
      label: "bash (sandboxed)",
      async execute(id, params, signal, onUpdate, toolCtx) {
        if (!enabled || !bwrapPath) {
          return localBash.execute(id, params, signal, onUpdate, toolCtx);
        }
        const sandboxed = createBashTool(cwd, { operations: createSandboxedBashOps(bwrapPath!, bwrapArgs) });
        return sandboxed.execute(id, params, signal, onUpdate, toolCtx);
      },
    });

    pi.on("user_bash", () => {
      if (!enabled || !bwrapPath) return;
      const bwrapArgs = buildBwrapArgs(rules, sessionCwd);
      return { operations: createSandboxedBashOps(bwrapPath!, bwrapArgs) };
    });
  }

  // ── /sandbox command ──────────────────────────────────────────────────────

  pi.registerCommand("sandbox", {
    description: "Show sandbox status or toggle on/off",
    handler: async (args, ctx) => {
      const arg = args?.trim().toLowerCase();

      if (arg === "on") {
        if (enabled) { ctx.ui.notify("[sandbox] already enabled", "info"); return; }
        const config = loadConfig(ctx.cwd);
        rules   = resolveRules(config, ctx.cwd);
        enabled = true;
        applyBashOverride(ctx.cwd, ctx);
        ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", "🔒 sandbox: on"));
        ctx.ui.notify("[sandbox] enabled", "info");
        return;
      }

      if (arg === "off") {
        enabled = false;
        ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("warning", "⚠ sandbox: off"));
        ctx.ui.notify("[sandbox] disabled for this session", "warning");
        return;
      }

      // Status display
      const lines = [
        `Sandbox: ${enabled ? "ENABLED" : "DISABLED"}`,
        `bwrap:   ${bwrapPath ?? "not found (layer 2 unavailable)"}`,
        "",
        "Active policy (most-specific first):",
        ...rules.map(r => `  ${r.access.padEnd(12)} ${r.resolved}`),
        "",
        "Default (unmatched paths): read-only",
        "",
        "Commands: /sandbox on | /sandbox off",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
