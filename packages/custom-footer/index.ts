/**
 * custom-footer — Replicates pi's built-in FooterComponent via ctx.ui.setFooter().
 *
 * Renders three sections:
 *
 *   ~/Repos/my-project (main) • My Session
 *   ↑9 ↓5.6k R119k W31k $0.000 (sub) 3.5%/1.0M   (provider) claude-sonnet-4-6 • medium
 *   ext-status-a  ext-status-b
 *
 * Line 1  — CWD (~ shortened), git branch, session name
 * Line 2  — Token stats (input/output/cache/cost), context %, model + provider + thinking level
 * Line 3+ — Extension statuses (from ctx.ui.setStatus()), sorted alphabetically
 *
 * Reactive to: git branch changes, model selection changes.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ─── Helpers (mirrors FooterComponent internals) ──────────────────────────────

/**
 * Sanitize status text for single-line display.
 * Strips newlines, tabs, carriage returns and collapses repeated spaces.
 */
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format a token count to a compact human-readable string.
 * Mirrors the `formatTokens()` helper used by the built-in footer.
 */
function formatTokens(count: number): string {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Stored so the model_select event can trigger re-renders from outside the
	// footer factory closure.
	let requestRender: (() => void) | undefined;

	// Re-render whenever the model (or thinking level) changes.
	pi.on("model_select", () => {
		requestRender?.();
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();

			// Subscribe to git-branch changes and trigger re-renders.
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					unsubBranch();
					requestRender = undefined;
				},

				invalidate() {
					// No pre-baked state to clear.
				},

				render(width: number): string[] {
					// ── Token stats (cumulative across ALL entries, not just branch) ──
					let totalInput = 0;
					let totalOutput = 0;
					let totalCacheRead = 0;
					let totalCacheWrite = 0;
					let totalCost = 0;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const m = entry.message as AssistantMessage;
							totalInput += m.usage.input;
							totalOutput += m.usage.output;
							totalCacheRead += m.usage.cacheRead;
							totalCacheWrite += m.usage.cacheWrite;
							totalCost += m.usage.cost.total;
						}
					}

					// ── Context usage ──────────────────────────────────────────────
					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent =
						contextUsage?.percent != null ? contextPercentValue.toFixed(1) : "?";

					// ── Line 1: pwd (git branch) • session name ────────────────────
					let pwd = ctx.sessionManager.getCwd();
					const home = process.env.HOME ?? process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) {
						pwd = `~${pwd.slice(home.length)}`;
					}

					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;

					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					// ── Line 2: token stats + context % ───────────────────────────
					const statsParts: string[] = [];
					if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
					if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
					if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
					if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

					// Show cost; append "(sub)" when model is on an OAuth subscription.
					const usingSubscription =
						ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
					if (totalCost || usingSubscription) {
						statsParts.push(
							`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`,
						);
					}

					// Context percentage – colour-coded by saturation.
					const contextPercentDisplay =
						contextPercent === "?"
							? `?/${formatTokens(contextWindow)}`
							: `${contextPercent}%/${formatTokens(contextWindow)}`;

					let contextPercentStr: string;
					if (contextPercentValue > 90) {
						contextPercentStr = theme.fg("error", contextPercentDisplay);
					} else if (contextPercentValue > 70) {
						contextPercentStr = theme.fg("warning", contextPercentDisplay);
					} else {
						contextPercentStr = contextPercentDisplay;
					}
					statsParts.push(contextPercentStr);

					let statsLeft = statsParts.join(" ");

					// ── Right side: model name + thinking level ───────────────────
					const modelName = ctx.model?.id ?? "no-model";
					let rightSideWithoutProvider = modelName;
					if (ctx.model?.reasoning) {
						const thinkingLevel = pi.getThinkingLevel();
						rightSideWithoutProvider =
							thinkingLevel === "off"
								? `${modelName} • thinking off`
								: `${modelName} • ${thinkingLevel}`;
					}

					// Prepend provider name when multiple providers are configured.
					let rightSide = rightSideWithoutProvider;
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						const withProvider = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
						const needed =
							visibleWidth(statsLeft) + 2 /* minPadding */ + visibleWidth(withProvider);
						if (needed <= width) rightSide = withProvider;
					}

					// ── Assemble stats line with right-alignment ──────────────────
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					const minPadding = 2;
					const rightSideWidth = visibleWidth(rightSide);
					const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

					let statsLine: string;
					if (totalNeeded <= width) {
						// Both sides fit — pad to right-align the model name.
						const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
						statsLine = statsLeft + padding + rightSide;
					} else {
						// Truncate right side to available space.
						const availableForRight = width - statsLeftWidth - minPadding;
						if (availableForRight > 0) {
							const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
							const truncatedRightWidth = visibleWidth(truncatedRight);
							const padding = " ".repeat(
								Math.max(0, width - statsLeftWidth - truncatedRightWidth),
							);
							statsLine = statsLeft + padding + truncatedRight;
						} else {
							statsLine = statsLeft;
						}
					}

					// Apply dim to left and right parts independently.
					// statsLeft may contain colour-reset escapes (from context % colouring),
					// so wrapping the whole line in a single dim() would clobber the colour.
					const dimStatsLeft = theme.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
					const dimRemainder = theme.fg("dim", remainder);

					const pwdLine = truncateToWidth(
						theme.fg("dim", pwd),
						width,
						theme.fg("dim", "..."),
					);

					const lines = [pwdLine, dimStatsLeft + dimRemainder];

					// ── Line 3+: extension statuses ───────────────────────────────
					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const sortedStatuses = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text));
						const statusLine = sortedStatuses.join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	});
}
