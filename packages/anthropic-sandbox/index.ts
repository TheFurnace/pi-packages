/**
 * Anthropic Sandbox Extension — OS-level sandboxing for bash commands
 *
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux).
 *
 * This extension overrides the built-in `bash` tool so every agent bash
 * invocation (and user-bash) runs inside the sandbox automatically.
 *
 * Config files (merged, project takes precedence):
 *   ~/.pi/agent/extensions/anthropic-sandbox.json  — global defaults
 *   .pi/anthropic-sandbox.json                     — project-level policy
 *
 * Example .pi/anthropic-sandbox.json:
 * ```json
 * {
 *   "enabled": true,
 *   "network": {
 *     "allowedDomains": ["github.com", "*.github.com"],
 *     "deniedDomains": []
 *   },
 *   "filesystem": {
 *     "denyRead": ["~/.ssh", "~/.aws"],
 *     "allowWrite": [".", "/tmp"],
 *     "denyWrite": [".env", ".env.*"]
 *   }
 * }
 * ```
 *
 * Usage:
 *   pi -e anthropic-sandbox                — sandbox enabled with defaults
 *   pi -e anthropic-sandbox --no-sandbox   — disable sandboxing
 *   /sandbox                               — show current sandbox configuration
 *
 * Supported platforms: macOS (sandbox-exec), Linux (bubblewrap).
 * Linux also requires: bubblewrap, socat, ripgrep.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type BashOperations, createBashTool, getAgentDir } from "@mariozechner/pi-coding-agent";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SandboxConfig extends SandboxRuntimeConfig {
	enabled?: boolean;
	ignoreViolations?: Record<string, string[]>;
	enableWeakerNestedSandbox?: boolean;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SandboxConfig = {
	enabled: true,
	network: {
		allowedDomains: [
			"npmjs.org",
			"*.npmjs.org",
			"registry.npmjs.org",
			"registry.yarnpkg.com",
			"pypi.org",
			"*.pypi.org",
			"github.com",
			"*.github.com",
			"api.github.com",
			"raw.githubusercontent.com",
		],
		deniedDomains: [],
	},
	filesystem: {
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
		allowWrite: [".", "/tmp"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key"],
	},
};

// ─── Config loading ───────────────────────────────────────────────────────────

function loadConfig(cwd: string): SandboxConfig {
	const globalConfigPath = join(getAgentDir(), "extensions", "anthropic-sandbox.json");
	const projectConfigPath = join(cwd, ".pi", "anthropic-sandbox.json");

	let globalConfig: Partial<SandboxConfig> = {};
	let projectConfig: Partial<SandboxConfig> = {};

	if (existsSync(globalConfigPath)) {
		try {
			globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
		}
	}

	if (existsSync(projectConfigPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
		}
	}

	return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
	const result: SandboxConfig = { ...base };

	if (overrides.enabled !== undefined) result.enabled = overrides.enabled;

	if (overrides.network) {
		result.network = { ...base.network, ...overrides.network };
	}

	if (overrides.filesystem) {
		result.filesystem = { ...base.filesystem, ...overrides.filesystem };
	}

	if (overrides.ignoreViolations !== undefined) {
		result.ignoreViolations = overrides.ignoreViolations;
	}

	if (overrides.enableWeakerNestedSandbox !== undefined) {
		result.enableWeakerNestedSandbox = overrides.enableWeakerNestedSandbox;
	}

	return result;
}

// ─── Sandboxed bash operations ────────────────────────────────────────────────

function createSandboxedBashOps(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			if (!existsSync(cwd)) {
				throw new Error(`Working directory does not exist: ${cwd}`);
			}

			const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

			return new Promise((resolve, reject) => {
				const child = spawn("bash", ["-c", wrappedCommand], {
					cwd,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;

				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						try {
							process.kill(-child.pid!, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}, timeout * 1000);
				}

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					reject(err);
				});

				const onAbort = () => {
					try {
						process.kill(-child.pid!, "SIGKILL");
					} catch {
						child.kill("SIGKILL");
					}
				};

				signal?.addEventListener("abort", onAbort, { once: true });

				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);

					if (signal?.aborted) {
						reject(new Error("aborted"));
					} else if (timedOut) {
						reject(new Error(`timeout:${timeout}`));
					} else {
						resolve({ exitCode: code ?? 1 });
					}
				});
			});
		},
	};
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-sandbox", {
		description: "Disable OS-level sandboxing for bash commands",
		type: "boolean",
		default: false,
	});

	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);

	let sandboxEnabled = false;
	let sandboxInitialized = false;

	// Override the built-in bash tool with a sandboxed version
	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, ctx) {
			if (!sandboxEnabled || !sandboxInitialized) {
				return localBash.execute(id, params, signal, onUpdate, ctx);
			}
			const sandboxedBash = createBashTool(localCwd, {
				operations: createSandboxedBashOps(),
			});
			return sandboxedBash.execute(id, params, signal, onUpdate, ctx);
		},
	});

	// Also sandbox user-initiated bash (e.g. ! commands in the TUI)
	pi.on("user_bash", () => {
		if (!sandboxEnabled || !sandboxInitialized) return;
		return { operations: createSandboxedBashOps() };
	});

	// ── session_start ──────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const noSandbox = pi.getFlag("no-sandbox") as boolean;

		if (noSandbox) {
			sandboxEnabled = false;
			ctx.ui.notify("Anthropic sandbox disabled via --no-sandbox", "warning");
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("warning", "⚠ sandbox: off"));
			return;
		}

		const config = loadConfig(ctx.cwd);

		if (!config.enabled) {
			sandboxEnabled = false;
			ctx.ui.notify("Anthropic sandbox disabled via config (enabled: false)", "info");
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("warning", "⚠ sandbox: off"));
			return;
		}

		const platform = process.platform;
		if (platform !== "darwin" && platform !== "linux") {
			sandboxEnabled = false;
			ctx.ui.notify(`Anthropic sandbox not supported on platform: ${platform}`, "warning");
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("warning", `⚠ sandbox: unsupported (${platform})`));
			return;
		}

		try {
			await SandboxManager.initialize({
				network: config.network,
				filesystem: config.filesystem,
				ignoreViolations: config.ignoreViolations,
				enableWeakerNestedSandbox: config.enableWeakerNestedSandbox,
			});

			sandboxEnabled = true;
			sandboxInitialized = true;

			const networkCount = config.network?.allowedDomains?.length ?? 0;
			const writeCount = config.filesystem?.allowWrite?.length ?? 0;
			ctx.ui.setStatus(
				"sandbox",
				ctx.ui.theme.fg("accent", `🔒 sandbox: ${networkCount} domains, ${writeCount} write paths`),
			);
			ctx.ui.notify("Anthropic sandbox initialized", "info");
		} catch (err) {
			sandboxEnabled = false;
			ctx.ui.notify(
				`Anthropic sandbox initialization failed: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("error", "✗ sandbox: init failed"));
		}
	});

	// ── session_shutdown ───────────────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		if (sandboxInitialized) {
			try {
				await SandboxManager.reset();
			} catch {
				// Ignore cleanup errors
			}
			sandboxInitialized = false;
		}
	});

	// ── /sandbox command ──────────────────────────────────────────────────────

	pi.registerCommand("sandbox", {
		description: "Show current Anthropic sandbox configuration and status",
		handler: async (_args, ctx) => {
			if (!sandboxEnabled) {
				ctx.ui.notify("Anthropic sandbox is currently disabled", "info");
				return;
			}

			const config = loadConfig(ctx.cwd);
			const lines = [
				"Anthropic Sandbox — Active Configuration",
				"",
				`Platform:   ${process.platform}`,
				`Status:     ${sandboxInitialized ? "initialized" : "not initialized"}`,
				"",
				"Network:",
				`  Allowed domains: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
				`  Denied domains:  ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
				"",
				"Filesystem:",
				`  Deny read:   ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
				`  Allow write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
				`  Deny write:  ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
				"",
				"Config files (project overrides global):",
				`  Global:  ${join(getAgentDir(), "extensions", "anthropic-sandbox.json")}`,
				`  Project: ${join(ctx.cwd, ".pi", "anthropic-sandbox.json")}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
