/**
 * markdown-fix: patches the pi-tui and pi-coding-agent dist files on first run
 * so that fenced code blocks render flush to the left edge (no paddingX margin),
 * wrap at full terminal width, and use the mdCodeBlock theme color for plain text
 * in syntax-highlighted blocks.
 *
 * The extension needs to modify dist files because pi's extension system runs
 * extensions inside a jiti CJS context with module isolation — prototype patches
 * applied there cannot reach the ESM module instances already loaded by the main app.
 *
 * Strategy:
 *  - On every session_start: resolve the dist files relative to process.argv[1]
 *    (pi's own cli.js), check if they already contain the patch sentinel, and if
 *    not apply the patches and prompt the user to restart pi once.
 *  - Idempotent: a sentinel string is written at the top of each patched file so
 *    subsequent sessions skip the check cheaply.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// Unique string written at the top of each file we patch.
// Presence means "already patched — nothing to do."
const SENTINEL = "/* @pi-agent/markdown-fix-v1 */\n";

// ─── locate dist files ────────────────────────────────────────────────────────

/**
 * Derive the node_modules root from pi's own entry-point path.
 *
 * process.argv[1] is something like:
 *   /tmp/bunx-…/node_modules/@mariozechner/pi-coding-agent/dist/cli.js
 *                              ^─────────────────────────────────────────
 *   4 levels up from cli.js gives node_modules/
 */
function findNodeModules(): string | null {
    const argv1 = process.argv[1];
    if (!argv1) return null;
    const candidate = path.resolve(argv1, "../../../../");
    if (existsSync(path.join(candidate, "@mariozechner"))) return candidate;
    return null;
}

// ─── patch helpers ────────────────────────────────────────────────────────────

function applyIfUnpatched(filePath: string, patches: Array<{ old: string; new: string }>): boolean {
    if (!existsSync(filePath)) return false;
    let content = readFileSync(filePath, "utf8");
    if (content.startsWith(SENTINEL)) return false; // already patched

    let changed = false;
    for (const { old, new: replacement } of patches) {
        if (content.includes(old)) {
            content = content.replace(old, replacement);
            changed = true;
        }
    }
    if (!changed) return false;

    writeFileSync(filePath, SENTINEL + content, "utf8");
    return true;
}

// ─── markdown.js patches ──────────────────────────────────────────────────────
//
// Three changes to @mariozechner/pi-tui/dist/components/markdown.js:
//   1. Insert the CODE_LINE_MARKER helpers after the import block.
//   2. Replace the wrapping + margin loops in render() to handle marked lines.
//   3. Replace the case "code" block in renderToken() to mark code lines.
//   4. Replace the code block branch in renderListItem() to mark code lines.

const MARKER_HELPERS = `\
// Code-block line marker — lines from fenced code blocks carry a NUL-byte
// prefix so render() can skip paddingX and wrap them at full terminal width.
const CODE_LINE_MARKER = "\\x00";
function isCodeBlockLine(line) {
    return line.length > 0 && line.charCodeAt(0) === 0;
}
function markCodeLine(line) {
    return CODE_LINE_MARKER + line;
}
function unmarkCodeLine(line) {
    return line.slice(1);
}
`;

const MARKDOWN_PATCHES: Array<{ old: string; new: string }> = [
    // 1. Insert helpers after the three import lines
    {
        old: `import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.js";\nexport class Markdown {`,
        new: `import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.js";\n${MARKER_HELPERS}export class Markdown {`,
    },

    // 2. Replace wrapping + margin loops
    {
        old: `\
        // Wrap lines (NO padding, NO background yet)
        const wrappedLines = [];
        for (const line of renderedLines) {
            if (isImageLine(line)) {
                wrappedLines.push(line);
            }
            else {
                wrappedLines.push(...wrapTextWithAnsi(line, contentWidth));
            }
        }
        // Add margins and background to each wrapped line
        const leftMargin = " ".repeat(this.paddingX);
        const rightMargin = " ".repeat(this.paddingX);
        const bgFn = this.defaultTextStyle?.bgColor;
        const contentLines = [];
        for (const line of wrappedLines) {
            if (isImageLine(line)) {
                contentLines.push(line);
                continue;
            }
            const lineWithMargins = leftMargin + line + rightMargin;
            if (bgFn) {
                contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
            }
            else {
                // No background - just pad to width
                const visibleLen = visibleWidth(lineWithMargins);
                const paddingNeeded = Math.max(0, width - visibleLen);
                contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
            }
        }`,
        new: `\
        // Wrap lines (NO padding, NO background yet)
        // Code block lines (marked with CODE_LINE_MARKER) wrap at full terminal
        // width so they are not constrained by paddingX.
        const wrappedLines = [];
        for (const line of renderedLines) {
            if (isImageLine(line)) {
                wrappedLines.push(line);
            }
            else if (isCodeBlockLine(line)) {
                const rawLine = unmarkCodeLine(line);
                for (const wl of wrapTextWithAnsi(rawLine, width)) {
                    wrappedLines.push(markCodeLine(wl));
                }
            }
            else {
                wrappedLines.push(...wrapTextWithAnsi(line, contentWidth));
            }
        }
        // Add margins and background to each wrapped line.
        // Code block lines are rendered flush to the left (no paddingX margin).
        const leftMargin = " ".repeat(this.paddingX);
        const rightMargin = " ".repeat(this.paddingX);
        const bgFn = this.defaultTextStyle?.bgColor;
        const contentLines = [];
        for (const line of wrappedLines) {
            if (isImageLine(line)) {
                contentLines.push(line);
                continue;
            }
            if (isCodeBlockLine(line)) {
                const rawLine = unmarkCodeLine(line);
                if (bgFn) {
                    contentLines.push(applyBackgroundToLine(rawLine, width, bgFn));
                }
                else {
                    const visibleLen = visibleWidth(rawLine);
                    const paddingNeeded = Math.max(0, width - visibleLen);
                    contentLines.push(rawLine + " ".repeat(paddingNeeded));
                }
                continue;
            }
            const lineWithMargins = leftMargin + line + rightMargin;
            if (bgFn) {
                contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
            }
            else {
                // No background - just pad to width
                const visibleLen = visibleWidth(lineWithMargins);
                const paddingNeeded = Math.max(0, width - visibleLen);
                contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
            }
        }`,
    },

    // 3. Replace renderToken case "code"
    {
        old: `\
            case "code": {
                const indent = this.theme.codeBlockIndent ?? "  ";
                lines.push(this.theme.codeBlockBorder(\`\\\`\\\`\\\`\${token.lang || ""}\`));
                if (this.theme.highlightCode) {
                    const highlightedLines = this.theme.highlightCode(token.text, token.lang);
                    for (const hlLine of highlightedLines) {
                        lines.push(\`\${indent}\${hlLine}\`);
                    }
                }
                else {
                    // Split code by newlines and style each line
                    const codeLines = token.text.split("\\n");
                    for (const codeLine of codeLines) {
                        lines.push(\`\${indent}\${this.theme.codeBlock(codeLine)}\`);
                    }
                }
                lines.push(this.theme.codeBlockBorder("\`\`\`"));
                if (nextTokenType && nextTokenType !== "space") {
                    lines.push(""); // Add spacing after code blocks (unless space token follows)
                }
                break;
            }`,
        new: `\
            case "code": {
                const indent = this.theme.codeBlockIndent ?? "";
                lines.push(markCodeLine(this.theme.codeBlockBorder(\`\\\`\\\`\\\`\${token.lang || ""}\`)));
                if (this.theme.highlightCode) {
                    const highlightedLines = this.theme.highlightCode(token.text, token.lang);
                    for (const hlLine of highlightedLines) {
                        // Apply base codeBlock color to plain text returned by cli-highlight
                        // (fixes the issue where lang-tagged blocks show default terminal color)
                        const colored = hlLine.includes("\\x1b") ? hlLine : this.theme.codeBlock(hlLine);
                        lines.push(markCodeLine(\`\${indent}\${colored}\`));
                    }
                }
                else {
                    // Split code by newlines and style each line
                    const codeLines = token.text.split("\\n");
                    for (const codeLine of codeLines) {
                        lines.push(markCodeLine(\`\${indent}\${this.theme.codeBlock(codeLine)}\`));
                    }
                }
                lines.push(markCodeLine(this.theme.codeBlockBorder("\`\`\`")));
                if (nextTokenType && nextTokenType !== "space") {
                    lines.push(""); // Add spacing after code blocks (unless space token follows)
                }
                break;
            }`,
    },

    // 4. Replace renderListItem code block branch
    {
        old: `\
            else if (token.type === "code") {
                // Code block in list item
                const indent = this.theme.codeBlockIndent ?? "  ";
                lines.push(this.theme.codeBlockBorder(\`\\\`\\\`\\\`\${token.lang || ""}\`));
                if (this.theme.highlightCode) {
                    const highlightedLines = this.theme.highlightCode(token.text, token.lang);
                    for (const hlLine of highlightedLines) {
                        lines.push(\`\${indent}\${hlLine}\`);
                    }
                }
                else {
                    const codeLines = token.text.split("\\n");
                    for (const codeLine of codeLines) {
                        lines.push(\`\${indent}\${this.theme.codeBlock(codeLine)}\`);
                    }
                }
                lines.push(this.theme.codeBlockBorder("\`\`\`"));
            }`,
        new: `\
            else if (token.type === "code") {
                // Code block in list item
                const indent = this.theme.codeBlockIndent ?? "";
                lines.push(markCodeLine(this.theme.codeBlockBorder(\`\\\`\\\`\\\`\${token.lang || ""}\`)));
                if (this.theme.highlightCode) {
                    const highlightedLines = this.theme.highlightCode(token.text, token.lang);
                    for (const hlLine of highlightedLines) {
                        const colored = hlLine.includes("\\x1b") ? hlLine : this.theme.codeBlock(hlLine);
                        lines.push(markCodeLine(\`\${indent}\${colored}\`));
                    }
                }
                else {
                    const codeLines = token.text.split("\\n");
                    for (const codeLine of codeLines) {
                        lines.push(markCodeLine(\`\${indent}\${this.theme.codeBlock(codeLine)}\`));
                    }
                }
                lines.push(markCodeLine(this.theme.codeBlockBorder("\`\`\`")));
            }`,
    },
];

// ─── theme.js patches ─────────────────────────────────────────────────────────
//
// Two changes to @mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js:
//   1. Add `default` key to buildCliHighlightTheme so plain text in syntax-
//      highlighted blocks gets the mdCodeBlock color (not terminal default).
//   2. Add `codeBlockIndent: ""` to getMarkdownTheme so the theme-level indent
//      is explicitly zero (the markdown renderer already defaults to "" now, but
//      being explicit here keeps the intent visible in the theme object).

const THEME_PATCHES: Array<{ old: string; new: string }> = [
    {
        old: `function buildCliHighlightTheme(t) {\n    return {\n        keyword: (s) => t.fg("syntaxKeyword", s),`,
        new: `function buildCliHighlightTheme(t) {\n    return {\n        default: (s) => t.fg("mdCodeBlock", s),\n        keyword: (s) => t.fg("syntaxKeyword", s),`,
    },
    {
        // Include `quote:` in the old text so this only matches the ORIGINAL file
        // (the patched file already has `codeBlockIndent: ""` between them).
        old: `        codeBlock: (text) => theme.fg("mdCodeBlock", text),\n        codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),\n        quote: (text) => theme.fg("mdQuote", text),`,
        new: `        codeBlock: (text) => theme.fg("mdCodeBlock", text),\n        codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),\n        codeBlockIndent: "",\n        quote: (text) => theme.fg("mdQuote", text),`,
    },
];

// ─── extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    pi.on("session_start", async (_event, ctx) => {
        const nodeModules = findNodeModules();
        if (!nodeModules) return;

        const markdownJs = path.join(nodeModules, "@mariozechner/pi-tui/dist/components/markdown.js");
        const themeJs = path.join(
            nodeModules,
            "@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js",
        );

        const patchedMarkdown = applyIfUnpatched(markdownJs, MARKDOWN_PATCHES);
        const patchedTheme = applyIfUnpatched(themeJs, THEME_PATCHES);

        if (patchedMarkdown || patchedTheme) {
            ctx.ui.notify(
                "markdown-fix: patches applied — please restart pi once for changes to take effect",
                "info",
            );
        }
    });
}
