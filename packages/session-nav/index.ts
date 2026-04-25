/**
 * session-nav — Session tree navigation helpers for pi.
 *
 * Commands:
 *   /jump-back    — Navigate to the previous user message in the current branch.
 *   /jump-forward — Walk forward to the end of the next turn (undo jump-back).
 *
 * Shortcuts: ctrl+, (back) / ctrl+. (forward)
 *   Pre-fill the editor with "/jump-back" or "/jump-forward" respectively
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
	// -------------------------------------------------------------------------
	// Shared helpers
	// -------------------------------------------------------------------------

	function extractText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		return content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("");
	}

	/** Walk [root, ..., leaf], return the first user-message entry before the leaf. */
	function findPreviousUserEntry(sm: any) {
		const branch = sm.getBranch();
		for (let i = branch.length - 2; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message.role === "user") return entry;
		}
		return null;
	}

	/**
	 * Walk forward from the current leaf through the most-recently-timestamped
	 * child, crossing exactly one user-message boundary, and return the ID of
	 * the last non-user entry in that turn.
	 */
	function findForwardTargetId(sm: any): string | null {
		const currentLeafId = sm.getLeafId();
		if (!currentLeafId) return null;

		let nodeId = currentLeafId;
		let lastNonUserId: string | null = null;
		let passedUserMessage = false;

		while (true) {
			const children = sm.getChildren(nodeId);
			if (children.length === 0) break;
			const mostRecent = children.reduce((a: any, b: any) =>
				new Date(a.timestamp).getTime() >= new Date(b.timestamp).getTime() ? a : b,
			);
			if (mostRecent.type === "message" && mostRecent.message.role === "user") {
				if (passedUserMessage) break;
				passedUserMessage = true;
				nodeId = mostRecent.id;
				continue;
			}
			lastNonUserId = mostRecent.id;
			nodeId = mostRecent.id;
		}
		return lastNonUserId;
	}

	// -------------------------------------------------------------------------
	// /jump-back
	// -------------------------------------------------------------------------

	pi.registerCommand("jump-back", {
		description: "Jump to the previous user message in the session tree",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const target = findPreviousUserEntry(ctx.sessionManager);
			if (!target) { ctx.ui.notify("Already at the earliest user message", "info"); return; }
			const result = await ctx.navigateTree(target.id, { summarize: false });
			if (result.cancelled) return;
			const text = extractText(target.message.content as string | Array<{ type: string; text?: string }>);
			if (text) ctx.ui.setEditorText(text);
			ctx.ui.notify("↑ Jumped to previous user message", "info");
		},
	});

	// -------------------------------------------------------------------------
	// /jump-forward
	// -------------------------------------------------------------------------

	pi.registerCommand("jump-forward", {
		description: "Jump forward to the next response in the session tree",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const targetId = findForwardTargetId(ctx.sessionManager as any);
			if (!targetId) { ctx.ui.notify("Already at the latest response", "info"); return; }
			const result = await ctx.navigateTree(targetId, { summarize: false });
			if (result.cancelled) return;
			ctx.ui.setEditorText("");
			ctx.ui.notify("↓ Jumped forward to next response", "info");
		},
	});

	// -------------------------------------------------------------------------
	// ctrl+, / ctrl+. shortcuts — pre-fill the editor with /jump-back or /jump-forward
	//
	// Shortcuts receive a stripped-down ExtensionContext: navigateTree() is not
	// present at runtime (casting to any throws). The only working path is to
	// route through typed command input. Pre-filling the editor with /jump-back
	// and pressing Enter triggers command interception with the full
	// ExtensionCommandContext, where navigateTree() is available.
	// -------------------------------------------------------------------------

	pi.registerShortcut(Key.ctrl("."), {
		description: "Jump forward to the next response (press Enter to confirm)",
		handler: async (ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Cannot navigate while agent is running", "warning");
				return;
			}
			ctx.ui.setEditorText("/jump-forward");
			ctx.ui.notify("Press Enter to jump to the next response", "info");
		},
	});

	pi.registerShortcut(Key.ctrl(","), {
		description: "Jump to the previous user message (press Enter to confirm)",
		handler: async (ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Cannot navigate while agent is running", "warning");
				return;
			}
			ctx.ui.setEditorText("/jump-back");
			ctx.ui.notify("Press Enter to jump to the previous user message", "info");
		},
	});
}
