/**
 * session-nav — Session tree navigation helpers for pi.
 *
 * Commands:
 *   /jump-back    — Navigate to the previous user message in the current branch.
 *   /jump-forward — Walk forward to the end of the next turn (undo jump-back).
 *   /jump-tree    — Open the user-message navigator and jump in one step.
 *   /jump-to <id> — Jump to a specific session entry by ID (used by the shortcut).
 *
 * Shortcuts: ctrl+, (back) / ctrl+. (forward)
 *   Pre-fill the editor with "/jump-back" or "/jump-forward" respectively
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Key, SelectList } from "@mariozechner/pi-tui";
import type { SelectItem } from "@mariozechner/pi-tui";

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

	/**
	 * Build a SelectList of all user messages across all branches.
	 * Returns the selected entry ID, or null if the user cancelled.
	 */
	async function pickUserMessage(ctx: any): Promise<string | null> {
		const allEntries: any[] = ctx.sessionManager.getEntries();
		const branchIds = new Set<string>(ctx.sessionManager.getBranch().map((e: any) => e.id));

		const userMessages = allEntries.filter(
			(e) => e.type === "message" && e.message.role === "user",
		);

		if (userMessages.length === 0) {
			ctx.ui.notify("No user messages in session", "info");
			return null;
		}

		const items: SelectItem[] = userMessages.map((entry: any) => {
			const raw = extractText(entry.message.content);
			const label = raw.length > 60 ? raw.slice(0, 60) + "…" : raw;
			return {
				value: entry.id,
				label: (branchIds.has(entry.id) ? "● " : "○ ") + label,
			};
		});

		// Start at the most recent user message on the current branch.
		let initialIndex = 0;
		for (let i = userMessages.length - 1; i >= 0; i--) {
			if (branchIds.has(userMessages[i].id)) { initialIndex = i; break; }
		}

		return ctx.ui.custom<string | null>((tui: any, theme: any, _kb: any, done: any) => {
			const list = new SelectList(items, Math.min(items.length, 14), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText:   (t) => theme.fg("accent", t),
				description:    (t) => theme.fg("muted", t),
				scrollInfo:     (t) => theme.fg("dim", t),
				noMatch:        (t) => theme.fg("warning", t),
			});
			list.setSelectedIndex(initialIndex);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			return {
				render:      (w: number) => list.render(w),
				invalidate:  () => list.invalidate(),
				handleInput: (d: string) => { list.handleInput(d); tui.requestRender(); },
			};
		});
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
	// /jump-tree — full one-step navigator (command context → navigateTree)
	// -------------------------------------------------------------------------

	pi.registerCommand("jump-tree", {
		description: "Open user-message navigator and jump immediately",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const selectedId = await pickUserMessage(ctx);
			if (!selectedId) return;

			const entry = ctx.sessionManager.getEntry(selectedId) as any;
			const result = await ctx.navigateTree(selectedId, { summarize: false });
			if (result.cancelled) return;

			if (entry?.type === "message" && entry.message.role === "user") {
				const text = extractText(entry.message.content);
				if (text) ctx.ui.setEditorText(text);
			}
			ctx.ui.notify("Jumped to selected user message", "info");
		},
	});

	// -------------------------------------------------------------------------
	// /jump-to <id> — navigate to a specific entry ID (used by the shortcut)
	// -------------------------------------------------------------------------

	pi.registerCommand("jump-to", {
		description: "Jump to a session entry by ID — used by the ctrl+x shortcut",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const entryId = args.trim();
			if (!entryId) { ctx.ui.notify("Usage: /jump-to <entry-id>", "warning"); return; }

			const entry = ctx.sessionManager.getEntry(entryId) as any;
			if (!entry) { ctx.ui.notify("Entry not found: " + entryId, "error"); return; }

			const result = await ctx.navigateTree(entryId, { summarize: false });
			if (result.cancelled) return;

			if (entry.type === "message" && entry.message.role === "user") {
				const text = extractText(entry.message.content);
				if (text) ctx.ui.setEditorText(text);
			} else {
				ctx.ui.setEditorText("");
			}
			ctx.ui.notify("Jumped to selected entry", "info");
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
