/**
 * sys-line — Adds "as <username>" to the pi footer status line.
 *
 * Uses ctx.ui.setStatus() which appends a line below the default footer:
 *
 *   ~/Repos/pi-packages (main)
 *   ↑9 ↓5.6k R119k W31k $0.000 (sub) 3.5%/1.0M (auto)   claude-sonnet-4.6 • medium
 *   as ferndq
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { userInfo } from "node:os";

export default function (pi: ExtensionAPI) {
	const currentUser = userInfo().username;
	const sudoUser = process.env.SUDO_USER;
	const label = sudoUser ? `${sudoUser} as ${currentUser}` : `as ${currentUser}`;

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("sys-line", ctx.ui.theme.fg("dim", label));
	});
}
