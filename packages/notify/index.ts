/**
 * Notify Extension
 *
 * Focus-aware notification when the agent finishes working.
 * Only fires when the terminal is not the active window — avoids noise when
 * you are already watching the output.
 *
 * Focus tracking uses ANSI focus-event mode (\x1b[?1004h): the terminal emits
 * \x1b[I on focus-gained and \x1b[O on focus-lost. Most modern terminals
 * support this (Kitty, GNOME Terminal, Alacritty, WezTerm, iTerm2,
 * Windows Terminal, etc.).
 *
 * Notification backends (probed once at session start, first available wins):
 *   1. OSC 777       — terminal in-band (iTerm2, WezTerm, Ghostty, rxvt-unicode)
 *   2. OSC 99        — Kitty in-band
 *   3. powershell    — Windows / WSL toast (special handling for Windows Terminal)
 *
 * ─── Notification modes ───────────────────────────────────────────────────────
 *
 * The title always shows the project context: "Pi — myapp (main)"
 * The body carries the work summary and elapsed time.
 *
 *   "smart"  — "<last-reply-snippet> · <tool-activity> · <duration>s"
 *              Extracts the first sentence of the final assistant message and
 *              builds a verbose tool-activity summary from the run's tool calls
 *              (specific filenames, bash command snippets, error flags). No
 *              network requests.
 *
 *   "ai"     — "<gpt-5-mini-summary> · <duration>s"
 *              Sends the user's original prompt, tool-activity summary, and
 *              the last assistant reply snippet to gpt-5-mini to produce a
 *              crisp one-phrase summary. Falls back to "smart" on any error.
 *              Requires OPENAI_API_KEY in the environment. The request uses a
 *              3-second timeout so failures are silent and fast.
 *
 * Set PI_NOTIFY_MODE=smart|ai to choose (default: "smart").
 *
 * TODO: explore per-distro / per-DE native backends more broadly before
 *       falling back to OSC sequences — e.g. kdialog (KDE), dunstify (dunst),
 *       sw-notify (sway/wlroots), alerter (macOS).
 *
 * Install: add to extensions in .pi/settings.json, or copy the folder to
 *          ~/.pi/agent/extensions/notify/
 * Requirements: one of the native backends above, or a terminal with OSC support
 */

import type { AgentMessage, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import path from "node:path";

// ─── Configuration ─────────────────────────────────────────────────────────

type NotifyMode = "smart" | "ai";

const CONFIG = {
	/**
	 * Notification body mode.
	 *
	 * Override at runtime with the PI_NOTIFY_MODE environment variable:
	 *   PI_NOTIFY_MODE=ai pi
	 */
	mode: (process.env.PI_NOTIFY_MODE ?? "smart") as NotifyMode,

	/** OpenAI model used in "ai" mode. */
	aiModel: "gpt-5-mini",

	/**
	 * Hard cap on the rendered notification body in characters.
	 * Characters beyond this limit are replaced with "…".
	 */
	maxBodyLength: 120,
};

// ─── ANSI focus-event tracking ────────────────────────────────────────────────

const FOCUS_ENABLE  = "\x1b[?1004h";
const FOCUS_DISABLE = "\x1b[?1004l";
const SEQ_FOCUS_IN  = "\x1b[I";
const SEQ_FOCUS_OUT = "\x1b[O";

// ─── Notification backends ────────────────────────────────────────────────────

type Backend = "powershell" | "osc777" | "osc99";

/** Pick OSC variant based on the running terminal. */
function oscFallback(): "osc777" | "osc99" {
	return process.env.KITTY_WINDOW_ID ? "osc99" : "osc777";
}

/**
 * Probe for the best available notification backend.
 * Prefer in-band OSC notifications by default. Use PowerShell toast when running
 * inside Windows Terminal (WT_SESSION).
 */
function probeBackend(): Backend {
	if (process.env.WT_SESSION) return "powershell";
	return oscFallback();
}

// ─── Per-backend dispatch ─────────────────────────────────────────────────────

/**
 * Dismiss/close a previously sent notification, where the backend supports it.
 *
 * OSC 99 (Kitty): close the notification with matching id.
 * OSC 777 / PowerShell: no standard close mechanism — no-op.
 */
function dismissNotification(backend: Backend): void {
	switch (backend) {
		case "osc99":
			// Kitty close sequence: same notification id (i=1), payload close
			process.stdout.write("\x1b]99;i=1:p=close;\x1b\\");
			break;
		case "osc777":
		case "powershell":
			// No standard close mechanism available for these backends.
			break;
	}
}

function windowsToastScript(title: string, body: string): string {
	const type     = "Windows.UI.Notifications";
	const mgr      = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast    = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
	].join("; ");
}

function sendNotification(backend: Backend, title: string, body: string): void {
	switch (backend) {
		case "powershell":
			execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)], () => {});
			break;

		case "osc777":
			process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
			break;

		case "osc99":
			process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
			process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
			break;
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Truncate text and append "…" if it exceeds max characters. */
function truncate(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/**
 * Extract the first sentence from text.
 * Falls back to the first non-empty line when no sentence-ending punctuation
 * is found within a reasonable range.
 */
function firstSentence(text: string): string {
	const match = text.match(/^.{8,}?[.!?](?:\s|$)/);
	if (match) return match[0].trim();
	return text.split("\n").find(l => l.trim().length > 0)?.trim() ?? text.trim();
}

/**
 * Find the last assistant message in a messages array and return its text
 * content blocks joined into a single string.
 */
function extractLastAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as any;
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			const textBlocks = msg.content
				.filter((b: any) => b.type === "text")
				.map((b: any) => (b.text as string).trim())
				.filter(Boolean);
			if (textBlocks.length > 0) return textBlocks.join(" ");
		}
	}
	return "";
}

// ─── Tool-activity tracking ───────────────────────────────────────────────────

interface ToolEntry {
	name: string;
	args: any;
	isError: boolean;
}

/**
 * Build a verbose human-readable summary of the tools that ran during the
 * agent turn.
 *
 * Files: lists specific basenames, up to 3, then "+N more".
 * Bash:  shows a snippet of each command (first line, ≤30 chars), up to 2,
 *        then "+N more". Failed commands are flagged with "(failed)".
 *
 * Examples:
 *   "edited auth.ts, server.ts · ran npm test, git commit -m 'fix auth'"
 *   "edited auth.ts, db.ts, api.ts +2 more · ran cargo build (failed) +1 more"
 *   "wrote config.json · ran npm install"
 */
function buildToolSummary(log: ToolEntry[]): string {
	const editedFiles: string[] = [];
	const bashEntries: { snippet: string; isError: boolean }[] = [];

	for (const { name, args, isError } of log) {
		if (name === "edit" || name === "write") {
			const filePath: string | undefined = args?.path;
			if (filePath) {
				const basename = path.basename(filePath);
				if (!editedFiles.includes(basename)) editedFiles.push(basename);
			}
		} else if (name === "bash") {
			const command: string = args?.command ?? "";
			const firstLine = command.split("\n")[0].trim();
			bashEntries.push({ snippet: truncate(firstLine, 30), isError });
		}
	}

	const parts: string[] = [];

	// Files: list up to 3 names, count the rest
	if (editedFiles.length > 0) {
		const shown = editedFiles.slice(0, 3);
		const rest  = editedFiles.length - shown.length;
		const verb  = editedFiles.length === 1 && log.find(e => e.name === "write" && path.basename(e.args?.path ?? "") === editedFiles[0])
			? "wrote"
			: "edited";
		parts.push(`${verb} ${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""}`);
	}

	// Bash: list up to 2 command snippets, count the rest
	if (bashEntries.length > 0) {
		const shown   = bashEntries.slice(0, 2);
		const rest    = bashEntries.length - shown.length;
		const cmdList = shown.map(c => c.snippet + (c.isError ? " (failed)" : "")).join(", ");
		parts.push(`ran ${cmdList}${rest > 0 ? ` +${rest} more` : ""}`);
	}

	return parts.join(" · ");
}

// ─── Git branch ───────────────────────────────────────────────────────────────

/**
 * Return the current git branch name for the given directory.
 * Returns an empty string if git is not available or not in a repo.
 */
async function getGitBranch(cwd: string, exec: ExtensionAPI["exec"]): Promise<string> {
	try {
		const result = await exec("git", ["branch", "--show-current"], { cwd, timeout: 2000 });
		return result.stdout.trim();
	} catch {
		return "";
	}
}

// ─── AI summary ───────────────────────────────────────────────────────────────

/**
 * Ask gpt-5-mini to produce a single short phrase summarising what was done.
 * Throws on any error (network, missing key, timeout) so the caller can fall
 * back gracefully.
 */
async function generateAiSummary(
	userPrompt: string,
	toolSummary: string,
	lastReply: string,
	model: string,
): Promise<string> {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error("OPENAI_API_KEY not set");

	const contextLines: string[] = [];
	if (userPrompt) contextLines.push(`Task: ${userPrompt.slice(0, 200)}`);
	if (toolSummary)  contextLines.push(`Actions: ${toolSummary}`);
	if (lastReply)    contextLines.push(`Result: ${lastReply.slice(0, 400)}`);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 3000);

	try {
		const response = await fetch("https://api.openai.com/v1/chat/completions", {
			method: "POST",
			signal: controller.signal,
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				max_tokens: 40,
				temperature: 0,
				messages: [
					{
						role: "system",
						content:
							"You generate desktop notification bodies for a coding agent. " +
							"Write exactly one short phrase (≤15 words) that concisely describes " +
							"what was accomplished. Be specific about files or features touched. " +
							"No trailing period.",
					},
					{ role: "user", content: contextLines.join("\n") },
				],
			}),
		});

		if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);

		const data = await response.json() as any;
		const text = (data?.choices?.[0]?.message?.content as string | undefined)?.trim() ?? "";
		if (!text) throw new Error("Empty response from OpenAI");
		return text;
	} finally {
		clearTimeout(timer);
	}
}

// ─── Notification builder ─────────────────────────────────────────────────────

interface RunState {
	startTime:  number;
	userPrompt: string;
	toolLog:    ToolEntry[];
}

/**
 * Build the notification title and body for an agent_end event.
 *
 * Title: "Pi — <cwd-basename> (<branch>)"  — always shows project context.
 * Body:  mode-specific work summary + elapsed time.
 */
async function buildNotification(
	mode: NotifyMode,
	messages: AgentMessage[],
	run: RunState,
	cwd: string,
	exec: ExtensionAPI["exec"],
): Promise<{ title: string; body: string }> {
	const [branch, elapsedSec] = await Promise.all([
		getGitBranch(cwd, exec),
		Promise.resolve(run.startTime > 0 ? Math.round((Date.now() - run.startTime) / 1000) : 0),
	]);

	const cwdName   = path.basename(cwd);
	const title     = branch ? `Pi — ${cwdName} (${branch})` : `Pi — ${cwdName}`;
	const timePart  = elapsedSec > 0 ? `${elapsedSec}s` : "";

	// Shared enrichment for both modes
	const toolSummary = buildToolSummary(run.toolLog);
	const rawReply    = extractLastAssistantText(messages);
	const snippet     = rawReply ? truncate(firstSentence(rawReply), 70) : "";

	const smartBody = (): string => {
		const parts = [snippet, toolSummary, timePart].filter(Boolean);
		return truncate(parts.join(" · "), CONFIG.maxBodyLength);
	};

	if (mode === "smart") {
		return { title, body: smartBody() };
	}

	// ai mode
	try {
		const summary = await generateAiSummary(run.userPrompt, toolSummary, rawReply, CONFIG.aiModel);
		const parts   = [summary, timePart].filter(Boolean);
		return { title, body: truncate(parts.join(" · "), CONFIG.maxBodyLength) };
	} catch {
		// Silent fallback to smart
		return { title, body: smartBody() };
	}
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Focus tracking state ─────────────────────────────────────────────────
	let isFocused      = true;
	let trackingActive = false;
	let stdinListener: ((chunk: Buffer) => void) | null = null;
	let backend: Backend = "osc777";

	// ── Per-agent-run state ───────────────────────────────────────────────────
	let runState: RunState = { startTime: 0, userPrompt: "", toolLog: [] };

	// ── Notification dismissal state ──────────────────────────────────────────
	/** True while a notification has been sent and not yet dismissed. */
	let notificationPending = false;

	// ── Focus helpers ─────────────────────────────────────────────────────────
	function enableFocusTracking() {
		if (trackingActive) return;
		process.stdout.write(FOCUS_ENABLE);
		stdinListener = (chunk: Buffer) => {
			const str = chunk.toString("binary");
			if (str.includes(SEQ_FOCUS_IN)) {
				isFocused = true;
				if (notificationPending) {
					dismissNotification(backend);
					notificationPending = false;
				}
			}
			if (str.includes(SEQ_FOCUS_OUT)) isFocused = false;
		};
		process.stdin.on("data", stdinListener);
		trackingActive = true;
	}

	function disableFocusTracking() {
		if (!trackingActive) return;
		process.stdout.write(FOCUS_DISABLE);
		if (stdinListener) {
			process.stdin.removeListener("data", stdinListener);
			stdinListener = null;
		}
		trackingActive = false;
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		isFocused = true;
		backend   = probeBackend();
		enableFocusTracking();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		disableFocusTracking();
	});

	// ── Per-run tracking ──────────────────────────────────────────────────────

	/** Capture the user's original prompt and reset per-run state. */
	pi.on("before_agent_start", async (event, _ctx) => {
		runState = {
			startTime:  Date.now(),
			userPrompt: event.prompt.trim(),
			toolLog:    [],
		};
	});

	/** Track every tool call for the tool-activity summary. */
	pi.on("tool_execution_end", async (event, _ctx) => {
		runState.toolLog.push({
			name:    event.toolName,
			args:    event.args,
			isError: event.isError,
		});
	});

	// ── Notification ──────────────────────────────────────────────────────────

	pi.on("agent_end", async (event, ctx) => {
		if (!ctx.hasUI) return;
		if (isFocused) return;

		const { title, body } = await buildNotification(
			CONFIG.mode,
			event.messages,
			runState,
			ctx.cwd,
			pi.exec.bind(pi),
		);

		sendNotification(backend, title, body);
		notificationPending = true;
	});
}
