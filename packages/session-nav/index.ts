/**
 * session-nav — Hotkey navigation through the session tree.
 *
 * Registers two commands and two shortcuts:
 *
 *   /jump-back    (ctrl+alt+up)   — Navigate to the previous user message.
 *                                   Leaf moves to its parent; the message text
 *                                   is placed in the editor for re-editing.
 *
 *   /jump-forward (ctrl+alt+down) — Walk forward through the most-recently-
 *                                   timestamped child chain, crossing one
 *                                   user-message boundary, and land on the
 *                                   last non-user entry of that turn.
 *                                   This reverses a /jump-back without
 *                                   storing any extra state.
 *
 * Shortcuts use pi.sendUserMessage() to invoke the commands because
 * registerShortcut handlers receive ExtensionContext, which does not
 * include navigateTree(). Commands receive ExtensionCommandContext,
 * which does.
 *
 * Default keybindings can be overridden in ~/.pi/agent/keybindings.json.
 * The commands can also be invoked directly from the editor.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
	// -------------------------------------------------------------------------
	// Tree traversal helpers
	// -------------------------------------------------------------------------

	/**
	 * Walk the current branch from leaf toward root (skipping the leaf itself)
	 * and return the first user-message entry found, or null.
	 */
	function findPreviousUserEntry(ctx: ExtensionCommandContext) {
		const branch = ctx.sessionManager.getBranch(); // [root, ..., leaf]
		// branch[length-1] is always the current leaf — skip it and search backward.
		for (let i = branch.length - 2; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message.role === "user") {
				return entry;
			}
		}
		return null;
	}

	/**
	 * Walk forward from the current leaf through the most-recently-timestamped
	 * child at each step.
	 *
	 * Strategy: pass through exactly one user-message boundary, then keep
	 * collecting non-user entries until the branch tip or the next user
	 * message. Return the ID of the last non-user entry encountered — that
	 * is the natural "end of turn" landing point, mirroring where the leaf
	 * would sit after a full assistant response.
	 *
	 * Returns null when already at the tip (no children ahead).
	 */
	function findForwardTargetId(ctx: ExtensionCommandContext): string | null {
		const currentLeafId = ctx.sessionManager.getLeafId();
		if (!currentLeafId) return null;

		let nodeId = currentLeafId;
		let lastNonUserId: string | null = null;
		let passedUserMessage = false;

		while (true) {
			const children = ctx.sessionManager.getChildren(nodeId);
			if (children.length === 0) break;

			// Follow the most recently created child (= the most active branch).
			const mostRecent = children.reduce((a, b) =>
				new Date(a.timestamp).getTime() >= new Date(b.timestamp).getTime() ? a : b,
			);

			if (mostRecent.type === "message" && mostRecent.message.role === "user") {
				// Hit a user-message boundary.
				if (passedUserMessage) break; // Already crossed one — stop here.
				passedUserMessage = true;
				nodeId = mostRecent.id;
				continue;
			}

			// Non-user entry: record as the current best landing point and go deeper.
			lastNonUserId = mostRecent.id;
			nodeId = mostRecent.id;
		}

		return lastNonUserId;
	}

	/** Extract plain text from a user message's content (string or block array). */
	function extractText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		return content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("");
	}

	// -------------------------------------------------------------------------
	// Command handlers
	// -------------------------------------------------------------------------

	async function doJumpBack(ctx: ExtensionCommandContext): Promise<void> {
		await ctx.waitForIdle();

		const target = findPreviousUserEntry(ctx);
		if (!target) {
			ctx.ui.notify("Already at the earliest user message", "info");
			return;
		}

		// navigateTree on a user-message entry sets the leaf to its parent
		// and returns { cancelled }. Editor text must be set manually.
		const result = await ctx.navigateTree(target.id, { summarize: false });
		if (result.cancelled) return;

		const text = extractText(target.message.content as string | Array<{ type: string; text?: string }>);
		if (text) ctx.ui.setEditorText(text);

		ctx.ui.notify("↑ Jumped to previous user message", "info");
	}

	async function doJumpForward(ctx: ExtensionCommandContext): Promise<void> {
		await ctx.waitForIdle();

		const targetId = findForwardTargetId(ctx);
		if (!targetId) {
			ctx.ui.notify("Already at the latest response", "info");
			return;
		}

		// navigateTree on a non-user entry sets the leaf to that entry directly.
		const result = await ctx.navigateTree(targetId, { summarize: false });
		if (result.cancelled) return;

		// Landing on a non-user entry — clear any leftover editor text.
		ctx.ui.setEditorText("");

		ctx.ui.notify("↓ Jumped forward to next response", "info");
	}

	// -------------------------------------------------------------------------
	// Commands (receive ExtensionCommandContext → can call navigateTree)
	// -------------------------------------------------------------------------

	pi.registerCommand("jump-back", {
		description: "Jump to the previous user message in the session tree (shortcut: ctrl+alt+up)",
		handler: async (_args, ctx) => doJumpBack(ctx),
	});

	pi.registerCommand("jump-forward", {
		description: "Jump forward to the next response in the session tree (shortcut: ctrl+alt+down)",
		handler: async (_args, ctx) => doJumpForward(ctx),
	});

	// -------------------------------------------------------------------------
	// Shortcuts (receive ExtensionContext only → trigger commands via message)
	// -------------------------------------------------------------------------

	pi.registerShortcut(Key.ctrlAlt("up"), {
		description: "Jump to previous user message (see /jump-back)",
		handler: (ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Cannot navigate while agent is running", "warning");
				return;
			}
			pi.sendUserMessage("/jump-back");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("down"), {
		description: "Jump forward to next response (see /jump-forward)",
		handler: (ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Cannot navigate while agent is running", "warning");
				return;
			}
			pi.sendUserMessage("/jump-forward");
		},
	});
}
