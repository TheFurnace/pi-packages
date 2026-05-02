import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { chromium, firefox, webkit } from "playwright";
import type { BrowserContext, BrowserType, Page } from "playwright";
import TurndownService from "turndown";
import TurndownPluginGfm from "turndown-plugin-gfm";
import { Type } from "typebox";

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_CHARACTERS = 20_000;
const MAX_ALLOWED_CHARACTERS = 100_000;
const DEFAULT_KEY_LINK_LIMIT = 8;

const { gfm } = TurndownPluginGfm as { gfm?: (service: TurndownService) => void };

// ─── Types ───────────────────────────────────────────────────────────────────

type BrowserName = "chromium" | "firefox" | "webkit";
type ExtractedFrom = "main" | "article" | "body" | "document" | "navigation" | "links";
type ReadMode = "page" | "navigation" | "links" | "raw";
type LinkScope = "all" | "internal" | "external";
type NavigationSectionTag = "nav" | "header" | "aside" | "footer";

interface NavigationSection {
  tag: NavigationSectionTag;
  html: string;
}

interface ExtractedLink {
  href: string;
  text: string;
}

interface LinkFilterOptions {
  linkScope: LinkScope;
  sameSiteOnly: boolean;
}

interface ContentAssessment {
  textLength: number;
  wordCount: number;
  paragraphCount: number;
  headingCount: number;
  linkCount: number;
  score: number;
  isThin: boolean;
}

interface PageCandidate {
  markdown: string;
  extractedFrom: ExtractedFrom;
  assessment: ContentAssessment;
}

interface PageResult {
  markdown: string;
  extractedFrom: ExtractedFrom;
  assessment: ContentAssessment;
  fallbackUsed: boolean;
  keyLinksAdded: boolean;
  keyLinkCount: number;
}

// ─── Executable path overrides ──────────────────────────────────────────────
//
// On NixOS (and similar environments), Playwright's downloaded binaries are
// generic ELF executables that can't run without patching. The NixOS community
// convention is to set PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH (or a
// per-browser variant) to a NixOS-compatible binary from playwright-driver.browsers.
//
// Supported env vars (per-browser takes priority over the generic fallback):
//   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
//   PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH
//   PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH
//   PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH  (fallback for all browsers)

function getExecutablePathOverride(browserName: BrowserName): string | undefined {
  const perBrowser = {
    chromium: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    firefox:  process.env.PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH,
    webkit:   process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH,
  }[browserName];
  return perBrowser || process.env.PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH || undefined;
}

// ─── Browser pool ───────────────────────────────────────────────────────────
//
// A single browser process is expensive to start (~1-2s). We keep one alive
// per browser type and serve each request with a fresh BrowserContext instead
// (Playwright's equivalent of an incognito window — fully isolated cookies,
// storage, and auth). The browser is closed automatically after IDLE_TIMEOUT_MS
// of inactivity, but only once all in-flight requests have finished.
//
// Parallel-request safety:
//   • The launch promise is stored in the pool *before* any await, so two
//     concurrent cold-launch requests share the same Promise rather than each
//     spawning their own browser process.
//   • activeCount tracks how many requests are currently using a browser.
//     The idle timer is only started when the count drops back to zero.

const BROWSER_TYPES: Record<BrowserName, BrowserType> = { chromium, firefox, webkit };

const IDLE_TIMEOUT_MS = 60_000;

interface PoolEntry {
  browserPromise: Promise<import("playwright").Browser>;
  activeCount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const pool = new Map<BrowserName, PoolEntry>();

async function acquireBrowser(
  browserName: BrowserName,
  onUpdate: (msg: string) => void,
): Promise<import("playwright").Browser> {
  const existing = pool.get(browserName);

  if (existing) {
    // Wait for any in-progress launch to resolve, then check liveness.
    const browser = await existing.browserPromise;
    if (browser.isConnected()) {
      if (existing.idleTimer) { clearTimeout(existing.idleTimer); existing.idleTimer = null; }
      existing.activeCount++;
      return browser;
    }
    // Browser has disconnected (crashed, killed). Remove the stale entry and
    // fall through to a fresh launch below.
    pool.delete(browserName);
  }

  // Store the launch promise synchronously *before* any await so that
  // concurrent callers who reach this point while the launch is in-flight
  // will hit the `existing` branch above and share this promise.
  const launchPromise = (async () => {
    await ensureBrowser(browserName, onUpdate);
    onUpdate(`Launching headless ${browserName}...`);
    try {
      const executablePath = getExecutablePathOverride(browserName);
      return await BROWSER_TYPES[browserName].launch({
        headless: true,
        ...(browserName === "chromium" ? { args: ["--no-sandbox", "--disable-setuid-sandbox"] } : {}),
        ...(executablePath ? { executablePath } : {}),
      });
    } catch (err) {
      // Launch failed (e.g. binary incompatible with this OS). Remove the
      // entry so the next call gets a fresh attempt rather than re-awaiting
      // a permanently-rejected promise.
      pool.delete(browserName);
      throw err;
    }
  })();

  pool.set(browserName, { browserPromise: launchPromise, activeCount: 1, idleTimer: null });
  return launchPromise;
}

function releaseBrowser(browserName: BrowserName): void {
  const entry = pool.get(browserName);
  if (!entry) return;
  entry.activeCount--;
  if (entry.activeCount > 0) return; // still in use by other requests
  entry.idleTimer = setTimeout(() => {
    pool.delete(browserName);
    entry.browserPromise.then((b) => b.close()).catch(() => {});
  }, IDLE_TIMEOUT_MS);
}

/**
 * Ensure the Playwright-managed binary for the given browser is installed,
 * downloading it programmatically if needed (no CLI, no npx).
 * Throws a clear error if installation fails.
 */
async function ensureBrowser(browserName: BrowserName, onUpdate: (msg: string) => void): Promise<void> {
  // Note: ensureBrowser only downloads/verifies the binary. Actual launching
  // is handled by acquireBrowser so the launch promise can be shared.

  // If an executable path override is configured (e.g. on NixOS via
  // PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH), skip the registry install
  // entirely — we'll use the external binary as-is.
  const override = getExecutablePathOverride(browserName);
  if (override) {
    if (!existsSync(override)) {
      throw new Error(
        `Executable path override for ${browserName} not found: ${override}\n` +
        `Check the value of PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH / PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH.`,
      );
    }
    onUpdate(`Using executable override for ${browserName}: ${override}`);
    return;
  }
  const { registry } = require("playwright-core/lib/server/registry/index") as {
    registry: {
      resolveBrowsers: (browsers: string[], opts: object) => any[];
      install: (executables: any[], opts: object) => Promise<void>;
    };
  };

  const executables = registry.resolveBrowsers([browserName], {});
  const pw = executables.find((e: any) => e.name === browserName);
  const exePath: string | undefined = pw?.executablePath?.("javascript");

  if (exePath && existsSync(exePath)) {
    onUpdate(`Using Playwright-managed ${browserName}: ${exePath}`);
    return;
  }

  onUpdate(`Playwright ${browserName} not installed — downloading (this only happens once)...`);
  try {
    await registry.install(executables, { force: false });
  } catch (e: any) {
    throw new Error(
      `Failed to install Playwright ${browserName}: ${String(e.message)}\n` +
      `Run 'bun run playwright install ${browserName}' in the playwright-web package directory to install manually.`,
    );
  }

  const installedPath: string | undefined = pw?.executablePath?.("javascript");
  if (!installedPath || !existsSync(installedPath)) {
    throw new Error(
      `Playwright ${browserName} download completed but binary not found at expected path.\n` +
      `Expected: ${installedPath ?? "(unknown)"}`,
    );
  }
  onUpdate(`Playwright ${browserName} installed: ${installedPath}`);
}

// ─── URL helpers ─────────────────────────────────────────────────────────────

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("URL is required");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function normalizeMode(input?: string): ReadMode {
  const mode = (input ?? "page").trim().toLowerCase();
  if (mode === "page" || mode === "navigation" || mode === "links" || mode === "raw") return mode as ReadMode;
  throw new Error('Invalid mode. Expected "page", "navigation", "links", or "raw".');
}

function normalizeLinkScope(input?: string): LinkScope {
  const scope = (input ?? "all").trim().toLowerCase();
  if (scope === "all" || scope === "internal" || scope === "external") return scope as LinkScope;
  throw new Error('Invalid linkScope. Expected "all", "internal", or "external".');
}

// ─── HTML extraction helpers ─────────────────────────────────────────────────

function extractPreferredFragment(html: string): { html: string; extractedFrom: ExtractedFrom } {
  const patterns: Array<{
    extractedFrom: Exclude<ExtractedFrom, "document" | "navigation" | "links">;
    pattern: RegExp;
  }> = [
    { extractedFrom: "main",    pattern: /<main\b[^>]*>([\s\S]*?)<\/main>/i },
    { extractedFrom: "article", pattern: /<article\b[^>]*>([\s\S]*?)<\/article>/i },
    { extractedFrom: "body",    pattern: /<body\b[^>]*>([\s\S]*?)<\/body>/i },
  ];
  for (const candidate of patterns) {
    const match = html.match(candidate.pattern);
    if (match?.[1]) return { html: match[1], extractedFrom: candidate.extractedFrom };
  }
  return { html, extractedFrom: "document" };
}

function extractBodyFragment(html: string): { html: string; extractedFrom: ExtractedFrom } {
  const match = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (match?.[1]) return { html: match[1], extractedFrom: "body" };
  return { html, extractedFrom: "document" };
}

function stripBoilerplateHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "")
    .replace(/<canvas\b[^>]*>[\s\S]*?<\/canvas>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "");
}

function stripContentChrome(html: string): string {
  return stripBoilerplateHtml(html)
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, "");
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function normalizeInlineWhitespace(text: string): string {
  return decodeBasicEntities(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stripTagsToText(html: string): string {
  return normalizeInlineWhitespace(html.replace(/<[^>]+>/g, " "));
}

function separateAdjacentAnchors(html: string): string {
  return html.replace(/<\/a>\s*(<a\b)/gi, "</a> $1");
}

function normalizeHref(baseUrl: string, href: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function absolutizeAnchorHrefs(html: string, baseUrl: string): string {
  return html.replace(/(<a\b[^>]*\bhref=(['"]))(.*?)(\2)/gi, (_match, prefix, quote, href, suffix) => {
    if (!href || href.startsWith("javascript:") || href.startsWith("mailto:")) {
      return `${prefix}${href}${suffix}`;
    }
    return `${prefix}${normalizeHref(baseUrl, href)}${suffix}`;
  });
}

function extractAttribute(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`${name}=(['"])(.*?)\\1`, "i"));
  return match?.[2] ? normalizeInlineWhitespace(match[2]) : undefined;
}

function sanitizeNavigationSectionHtml(html: string, baseUrl: string): string {
  return separateAdjacentAnchors(
    absolutizeAnchorHrefs(html, baseUrl).replace(
      /<a\b([^>]*)href=(['"])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi,
      (_match, before, quote, href, after, inner) => {
        const attrs = `${before ?? ""} ${after ?? ""}`;
        const label = normalizeInlineWhitespace(
          stripTagsToText(inner ?? "")
          || extractAttribute(attrs, "aria-label")
          || extractAttribute(attrs, "title")
          || "",
        );
        if (!label) return "";
        return `<a href=${quote}${normalizeHref(baseUrl, href)}${quote}>${label}</a>`;
      },
    ),
  );
}

function extractNavigationSections(html: string, baseUrl: string): NavigationSection[] {
  const sections: NavigationSection[] = [];
  for (const tag of ["nav", "header", "aside", "footer"] as const) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
    for (const match of html.matchAll(pattern)) {
      const fragment = match[1]?.trim();
      if (!fragment) continue;
      sections.push({ tag, html: sanitizeNavigationSectionHtml(fragment, baseUrl) });
    }
  }
  return sections;
}

function isInternalLink(href: string, baseUrl: string): boolean {
  try {
    return new URL(href, baseUrl).hostname === new URL(baseUrl).hostname;
  } catch {
    return false;
  }
}

function getSiteKey(hostname: string): string {
  const normalized = hostname.toLowerCase();
  if (!normalized || normalized === "localhost" || /^(\d{1,3}\.){3}\d{1,3}$/.test(normalized)) {
    return normalized;
  }
  const parts = normalized.split(".").filter(Boolean);
  return parts.length <= 2 ? normalized : parts.slice(-2).join(".");
}

function isSameSiteLink(href: string, baseUrl: string): boolean {
  try {
    return getSiteKey(new URL(href, baseUrl).hostname) === getSiteKey(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

function filterLinks(links: ExtractedLink[], baseUrl: string, options: LinkFilterOptions): ExtractedLink[] {
  return links.filter((link) => {
    const internal = isInternalLink(link.href, baseUrl);
    if (options.linkScope === "internal" && !internal) return false;
    if (options.linkScope === "external" && internal) return false;
    if (options.sameSiteOnly && !isSameSiteLink(link.href, baseUrl)) return false;
    return true;
  });
}

function extractLinks(
  html: string,
  baseUrl: string,
  options: LinkFilterOptions,
): { links: ExtractedLink[]; totalLinkCount: number } {
  const allLinks: ExtractedLink[] = [];
  const seen = new Set<string>();
  const pattern = /<a\b([^>]*)href=(['"])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const rawHref = match[3]?.trim();
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:") || rawHref.startsWith("mailto:")) {
      continue;
    }
    const attrs = `${match[1] ?? ""} ${match[4] ?? ""}`;
    const href = normalizeHref(baseUrl, rawHref);
    const text = normalizeInlineWhitespace(
      stripTagsToText(match[5] ?? "")
      || extractAttribute(attrs, "aria-label")
      || extractAttribute(attrs, "title")
      || "",
    );
    if (!text) continue;
    const key = `${href}\n${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    allLinks.push({ href, text });
  }
  return {
    links: filterLinks(allLinks, baseUrl, options),
    totalLinkCount: allLinks.length,
  };
}

function buildLinksMarkdown(links: ExtractedLink[]): string {
  if (links.length === 0) return "_No links matched the requested filters._";
  return cleanupMarkdown(["# Links", ...links.map((l) => `- [${l.text}](${l.href})`)].join("\n\n"));
}

function normalizeMarkdownLinks(markdown: string, baseUrl: string): string {
  return markdown.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, text, href) => {
    if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) {
      return `[${text}](${href})`;
    }
    return `[${text}](${normalizeHref(baseUrl, href)})`;
  });
}

function stripMarkdownForAnalysis(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/[*_~\-|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function assessMarkdown(markdown: string): ContentAssessment {
  const text = stripMarkdownForAnalysis(markdown);
  const textLength = text.length;
  const wordCount = text ? text.split(/\s+/).length : 0;
  const paragraphCount = markdown
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !p.startsWith("#")).length;
  const headingCount = (markdown.match(/^#{1,6}\s+/gm) ?? []).length;
  const linkCount = (markdown.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length;
  const score = textLength + paragraphCount * 180 + headingCount * 120 - linkCount * 40;
  const isThin =
    textLength < 900
    || wordCount < 160
    || (paragraphCount < 4 && headingCount < 2)
    || (linkCount > 0 && textLength / Math.max(linkCount, 1) < 45);
  return { textLength, wordCount, paragraphCount, headingCount, linkCount, score, isThin };
}

function buildTurndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
  });
  if (gfm) service.use(gfm);
  return service;
}

function cleanupMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildPageCandidate(fragmentHtml: string, baseUrl: string, extractedFrom: ExtractedFrom): PageCandidate {
  const cleanedHtml = stripContentChrome(separateAdjacentAnchors(absolutizeAnchorHrefs(fragmentHtml, baseUrl)));
  let markdown = cleanupMarkdown(buildTurndownService().turndown(cleanedHtml));
  if (!markdown) markdown = stripTagsToText(cleanedHtml);
  markdown = cleanupMarkdown(normalizeMarkdownLinks(markdown, baseUrl));
  return { markdown, extractedFrom, assessment: assessMarkdown(markdown) };
}

function stripHash(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url.replace(/#.*$/, "");
  }
}

function buildKeyLinksSection(
  html: string,
  baseUrl: string,
  limit = DEFAULT_KEY_LINK_LIMIT,
): { markdown: string; count: number } {
  const cleanedHtml = stripBoilerplateHtml(absolutizeAnchorHrefs(html, baseUrl));
  const { links } = extractLinks(cleanedHtml, baseUrl, { linkScope: "internal", sameSiteOnly: true });
  const currentPage = stripHash(baseUrl);
  const selected = links
    .filter((l) => stripHash(l.href) !== currentPage)
    .filter((l) => l.text.length >= 2 && l.text.length <= 90)
    .slice(0, limit);
  if (selected.length === 0) return { markdown: "", count: 0 };
  return {
    markdown: cleanupMarkdown(["## Key links", ...selected.map((l) => `- [${l.text}](${l.href})`)].join("\n\n")),
    count: selected.length,
  };
}

function buildPageMarkdown(html: string, baseUrl: string, preferMainContent: boolean): PageResult {
  const preferredFragment = preferMainContent ? extractPreferredFragment(html) : extractBodyFragment(html);
  const primary = buildPageCandidate(preferredFragment.html, baseUrl, preferredFragment.extractedFrom);
  let chosen = primary;
  let fallbackUsed = false;
  if (primary.assessment.isThin && preferredFragment.extractedFrom !== "body") {
    const fallbackFragment = extractBodyFragment(html);
    const fallback = buildPageCandidate(fallbackFragment.html, baseUrl, fallbackFragment.extractedFrom);
    if (fallback.assessment.score > primary.assessment.score) {
      chosen = fallback;
      fallbackUsed = true;
    }
  }
  let keyLinksAdded = false;
  let keyLinkCount = 0;
  let markdown = chosen.markdown;
  if (chosen.assessment.isThin) {
    const keyLinks = buildKeyLinksSection(html, baseUrl);
    if (keyLinks.markdown) {
      markdown = cleanupMarkdown(`${markdown}\n\n${keyLinks.markdown}`);
      keyLinksAdded = true;
      keyLinkCount = keyLinks.count;
    }
  }
  return {
    markdown,
    extractedFrom: chosen.extractedFrom,
    assessment: chosen.assessment,
    fallbackUsed,
    keyLinksAdded,
    keyLinkCount,
  };
}

function buildNavigationMarkdown(
  html: string,
  baseUrl: string,
  options: LinkFilterOptions,
): { markdown: string; linkCount: number; totalLinkCount: number; sectionCount: number } {
  const cleanedHtml = stripBoilerplateHtml(absolutizeAnchorHrefs(html, baseUrl));
  const sections = extractNavigationSections(cleanedHtml, baseUrl);
  const { links, totalLinkCount } = extractLinks(cleanedHtml, baseUrl, options);
  const parts: string[] = [];
  if (sections.length > 0) {
    parts.push("# Navigation sections");
    for (const [index, section] of sections.entries()) {
      const sectionMarkdown = cleanupMarkdown(buildTurndownService().turndown(section.html));
      if (!sectionMarkdown) continue;
      parts.push(`## ${section.tag} ${index + 1}`);
      parts.push(sectionMarkdown);
    }
  }
  if (links.length > 0) parts.push(buildLinksMarkdown(links));
  const markdown =
    cleanupMarkdown(parts.join("\n\n")) || "_No navigation content or links were extracted from this page._";
  return { markdown, linkCount: links.length, totalLinkCount, sectionCount: sections.length };
}

function truncateText(text: string, maxCharacters: number): { text: string; truncated: boolean } {
  if (text.length <= maxCharacters) return { text, truncated: false };
  const slice = text.slice(0, maxCharacters);
  const breakIndex = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
  const cutoff = breakIndex > Math.floor(maxCharacters * 0.6) ? breakIndex : maxCharacters;
  return { text: `${slice.slice(0, cutoff).trimEnd()}\n\n…[truncated]`, truncated: true };
}

// ─── Interactive browser session helpers ────────────────────────────────────

const SESSION_IDLE_TIMEOUT_MS = 10 * 60_000;
const MAX_SNAPSHOT_ELEMENTS = 80;
const DEFAULT_SNAPSHOT_CHARACTERS = 20_000;
const DEFAULT_LOG_ENTRIES = 100;

type WaitUntil = "load" | "domcontentloaded" | "networkidle";

interface CapturedConsoleEntry {
  index: number;
  timestamp: string;
  type: string;
  text: string;
  location?: unknown;
}

interface CapturedNetworkEntry {
  index: number;
  timestamp: string;
  kind: "requestfailed" | "response";
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  failure?: string;
}

interface BrowserSession {
  id: string;
  browserName: BrowserName;
  context: BrowserContext;
  page: Page;
  createdAt: number;
  lastUsedAt: number;
  consoleEntries: CapturedConsoleEntry[];
  pageErrors: CapturedConsoleEntry[];
  networkEntries: CapturedNetworkEntry[];
  lastConsoleCursor: number;
  lastPageErrorCursor: number;
  lastNetworkCursor: number;
  artifactDir: string;
  screenshotCount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, BrowserSession>();
let nextSessionId = 1;
let nextConsoleIndex = 1;
let nextNetworkIndex = 1;

function makeSessionId(): string {
  return `browser-${Date.now().toString(36)}-${nextSessionId++}`;
}

function normalizeInteractiveUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("URL is required");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

function normalizeWaitUntil(input?: string, fallback: WaitUntil = "domcontentloaded"): WaitUntil {
  const value = (input ?? fallback).trim().toLowerCase();
  if (value === "load" || value === "domcontentloaded" || value === "networkidle") return value;
  throw new Error('Invalid waitUntil. Expected "load", "domcontentloaded", or "networkidle".');
}

function normalizeSnapshotMode(input?: string): "visible-elements" | "text" | "html" {
  const value = (input ?? "visible-elements").trim().toLowerCase();
  if (value === "visible-elements" || value === "text" || value === "html") return value as any;
  if (value === "accessibility") return "visible-elements";
  throw new Error('Invalid mode. Expected "visible-elements", "text", "html", or "accessibility".');
}

function touchSession(session: BrowserSession): void {
  session.lastUsedAt = Date.now();
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    closeBrowserSession(session.id).catch(() => {});
  }, SESSION_IDLE_TIMEOUT_MS);
}

async function closeBrowserSession(sessionId: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;
  sessions.delete(sessionId);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  try {
    await session.context.close();
  } finally {
    releaseBrowser(session.browserName);
  }
  return true;
}

async function closeAllBrowserResources(): Promise<{ sessionsClosed: number; browsersClosed: number }> {
  const sessionIds = Array.from(sessions.keys());
  await Promise.all(sessionIds.map((id) => closeBrowserSession(id).catch(() => false)));

  const entries = Array.from(pool.entries());
  pool.clear();
  await Promise.all(entries.map(async ([, entry]) => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try {
      const browser = await entry.browserPromise;
      if (browser.isConnected()) await browser.close();
    } catch {
      // Best-effort cleanup during harness/session teardown.
    }
  }));

  return { sessionsClosed: sessionIds.length, browsersClosed: entries.length };
}

function getBrowserSession(sessionId: string): BrowserSession {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown browser session: ${sessionId}`);
  if (session.page.isClosed()) {
    sessions.delete(sessionId);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.context.close().catch(() => {});
    releaseBrowser(session.browserName);
    throw new Error(`Browser session is closed: ${sessionId}`);
  }
  touchSession(session);
  return session;
}

function registerSessionListeners(session: BrowserSession): void {
  const page = session.page;
  page.on("console", (message) => {
    session.consoleEntries.push({
      index: nextConsoleIndex++,
      timestamp: new Date().toISOString(),
      type: message.type(),
      text: message.text(),
      location: message.location(),
    });
    if (session.consoleEntries.length > 500) session.consoleEntries.splice(0, session.consoleEntries.length - 500);
  });
  page.on("pageerror", (error) => {
    session.pageErrors.push({
      index: nextConsoleIndex++,
      timestamp: new Date().toISOString(),
      type: "pageerror",
      text: error.stack || error.message || String(error),
    });
    if (session.pageErrors.length > 200) session.pageErrors.splice(0, session.pageErrors.length - 200);
  });
  page.on("requestfailed", (request) => {
    session.networkEntries.push({
      index: nextNetworkIndex++,
      timestamp: new Date().toISOString(),
      kind: "requestfailed",
      method: request.method(),
      url: request.url(),
      failure: request.failure()?.errorText,
    });
    if (session.networkEntries.length > 500) session.networkEntries.splice(0, session.networkEntries.length - 500);
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    session.networkEntries.push({
      index: nextNetworkIndex++,
      timestamp: new Date().toISOString(),
      kind: "response",
      method: response.request().method(),
      url: response.url(),
      status,
      statusText: response.statusText(),
    });
    if (session.networkEntries.length > 500) session.networkEntries.splice(0, session.networkEntries.length - 500);
  });
}

async function createBrowserSession(
  browserName: BrowserName,
  options: {
    viewport?: { width: number; height: number };
    deviceScaleFactor?: number;
    mobile?: boolean;
    hasTouch?: boolean;
  },
  onUpdate: (msg: string) => void,
): Promise<BrowserSession> {
  const browser = await acquireBrowser(browserName, onUpdate);
  const sessionId = makeSessionId();
  const artifactDir = join(tmpdir(), "pi-playwright-web", sessionId);
  mkdirSync(artifactDir, { recursive: true });
  try {
    const context = await browser.newContext({
      ...(options.viewport ? { viewport: options.viewport } : {}),
      ...(options.deviceScaleFactor ? { deviceScaleFactor: options.deviceScaleFactor } : {}),
      ...(options.mobile !== undefined ? { isMobile: options.mobile } : {}),
      ...(options.hasTouch !== undefined ? { hasTouch: options.hasTouch } : {}),
      userAgent:
        browserName === "chromium"
          ? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          : undefined,
    });
    const page = await context.newPage();
    const session: BrowserSession = {
      id: sessionId,
      browserName,
      context,
      page,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      consoleEntries: [],
      pageErrors: [],
      networkEntries: [],
      lastConsoleCursor: 0,
      lastPageErrorCursor: 0,
      lastNetworkCursor: 0,
      artifactDir,
      screenshotCount: 0,
      idleTimer: null,
    };
    registerSessionListeners(session);
    sessions.set(sessionId, session);
    touchSession(session);
    return session;
  } catch (err) {
    releaseBrowser(browserName);
    throw err;
  }
}

async function getVisibleText(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const body = (globalThis as any).document?.body;
    return (body?.innerText || "").trim();
  });
}

async function getInteractiveElements(page: Page): Promise<Array<Record<string, string>>> {
  return await page.evaluate((limit) => {
    const doc = (globalThis as any).document;
    const win = (globalThis as any).window;
    if (!doc) return [];
    const selector = "a,button,input,textarea,select,summary,[role],[data-testid]";
    const nodes = Array.from(doc.querySelectorAll(selector));
    function isVisible(el: any): boolean {
      const style = win.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style && style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }
    function textOf(el: any): string {
      const parts = [
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.getAttribute("placeholder"),
        el.labels ? Array.from(el.labels).map((l: any) => l.innerText).join(" ") : "",
        el.innerText,
        el.value && el.tagName !== "INPUT" ? el.value : "",
      ];
      return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 120);
    }
    function roleOf(el: any): string {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button") return "button";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "summary") return "button";
      if (tag === "input") {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "submit" || type === "button") return "button";
        return "textbox";
      }
      return tag;
    }
    return nodes.filter(isVisible).slice(0, limit).map((el: any) => ({
      role: roleOf(el),
      name: textOf(el),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || "",
      testId: el.getAttribute("data-testid") || "",
      href: el.getAttribute("href") || "",
    }));
  }, MAX_SNAPSHOT_ELEMENTS);
}

function formatElements(elements: Array<Record<string, string>>): string {
  if (elements.length === 0) return "_No visible interactive elements found._";
  return elements.map((el) => {
    const bits = [el.role || el.tag, el.name ? `"${el.name}"` : "", el.testId ? `data-testid=${el.testId}` : "", el.type ? `type=${el.type}` : ""].filter(Boolean);
    return `- ${bits.join(" ")}`;
  }).join("\n");
}

async function buildSessionSnapshot(page: Page, mode: "visible-elements" | "text" | "html", maxCharacters: number): Promise<string> {
  const url = page.url();
  const title = await page.title();
  if (mode === "html") {
    const html = await page.content();
    const truncated = truncateText(html, maxCharacters);
    return `URL: ${url}\nTitle: ${title}\nMode: html\n\n---\n\n${truncated.text}`;
  }
  const visibleText = await getVisibleText(page);
  if (mode === "text") {
    const truncated = truncateText(visibleText || "_No visible text found._", maxCharacters);
    return `URL: ${url}\nTitle: ${title}\nMode: text\n\n---\n\n${truncated.text}`;
  }
  const elements = await getInteractiveElements(page);
  const textPreview = truncateText(visibleText || "_No visible text found._", Math.min(maxCharacters, 8_000)).text;
  const snapshot = `URL: ${url}\nTitle: ${title}\nMode: visible-elements\n\n## Visible interactive elements\n\n${formatElements(elements)}\n\n## Visible text\n\n${textPreview}`;
  return truncateText(snapshot, maxCharacters).text;
}

async function summarizeCurrentPage(session: BrowserSession): Promise<string> {
  return buildSessionSnapshot(session.page, "visible-elements", 8_000);
}

async function resolveLocator(page: Page, params: any): Promise<{ locator: any; description: string }> {
  if (params.role) {
    return { locator: page.getByRole(params.role as any, params.name ? { name: params.name, exact: params.exact ?? false } : undefined), description: `role=${params.role}${params.name ? ` name=${JSON.stringify(params.name)}` : ""}` };
  }
  if (params.label) return { locator: page.getByLabel(params.label, { exact: params.exact ?? false }), description: `label=${JSON.stringify(params.label)}` };
  if (params.placeholder) return { locator: page.getByPlaceholder(params.placeholder, { exact: params.exact ?? false }), description: `placeholder=${JSON.stringify(params.placeholder)}` };
  if (params.testId) return { locator: page.getByTestId(params.testId), description: `testId=${JSON.stringify(params.testId)}` };
  if (params.text) return { locator: page.getByText(params.text, { exact: params.exact ?? false }), description: `text=${JSON.stringify(params.text)}` };
  if (params.css) return { locator: page.locator(params.css), description: `css=${JSON.stringify(params.css)}` };
  throw new Error("No locator provided. Use role/name, label, placeholder, testId, text, or css.");
}

async function assertSingleLocator(page: Page, params: any): Promise<{ locator: any; description: string; count: number }> {
  const resolved = await resolveLocator(page, params);
  const count = await resolved.locator.count();
  if (count === 0) {
    const candidates = formatElements(await getInteractiveElements(page));
    throw new Error(`Locator matched no elements (${resolved.description}). Candidate visible elements:\n${candidates}`);
  }
  if (count > 1 && params.nth === undefined) {
    throw new Error(`Locator matched ${count} elements (${resolved.description}). Provide a more specific locator or nth.`);
  }
  return { locator: params.nth !== undefined ? resolved.locator.nth(params.nth) : resolved.locator.first(), description: resolved.description, count };
}

function formatEvalValue(value: unknown, maxCharacters: number): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  if (text === undefined) text = "undefined";
  return truncateText(text, maxCharacters).text;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function makeTextResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text", text }], details };
}

// ─── Extension entry point ───────────────────────────────────────────────────

function normalizeBrowser(input?: string): BrowserName {
  const name = (input ?? "chromium").trim().toLowerCase();
  if (name === "chromium" || name === "firefox" || name === "webkit") return name as BrowserName;
  throw new Error('Invalid browser. Expected "chromium", "firefox", or "webkit".');
}

export default function playwrightWebExtension(pi: ExtensionAPI) {
  // Pi emits session_shutdown when the current extension runtime is torn down
  // for /reload, /new, /resume, /fork, or quit. Clean up persistent browser
  // sessions and pooled browser processes here so reloaded/replaced sessions do
  // not inherit stale Playwright children from the old extension instance.
  pi.on("session_shutdown", async () => {
    await closeAllBrowserResources();
  });

  const tool = {
    name: "read_website_browser",
    label: "Read Website (Browser)",
    description:
      "Fetch a web page using a headless browser (Chromium, Firefox, or WebKit), with full JavaScript execution and SPA support, then convert its HTML to Markdown.",
    promptSnippet:
      "Fetch an HTTP(S) page using a real headless browser (JavaScript enabled, SPA-friendly) and convert it to Markdown.",
    promptGuidelines: [
      "Use read_website_browser when read_website fails to extract content from a Single Page Application (SPA), React/Vue site, or any page that requires JavaScript to render.",
      "Prefer the lighter read_website tool for static pages — only escalate to read_website_browser when JavaScript rendering is needed.",
      "Use read_website_browser with mode navigation when the user wants menus, site structure, or navigational links from a JavaScript-rendered page.",
      "Use read_website_browser with mode links when the user wants only the links from a JavaScript-rendered page.",
      "Use read_website_browser with mode raw to get the fully-rendered HTML source of an SPA, useful for inspecting embedded JSON or finding internal API endpoints.",
      'The browser parameter selects the engine: "chromium" (default), "firefox", or "webkit". Chromium is the best default for most pages.',
    ],
    parameters: Type.Object({
      url: Type.String({
        description: "HTTP or HTTPS URL to fetch. If no scheme is provided, https:// is assumed.",
      }),
      mode: Type.Optional(
        Type.String({
          description:
            'Read mode: "page" (default) for readable Markdown content, "navigation" for nav/header/footer/aside content plus links, "links" for just links, or "raw" for the fully-rendered HTML source.',
        }),
      ),
      browser: Type.Optional(
        Type.String({
          description: 'Browser engine to use: "chromium" (default), "firefox", or "webkit". Each is a distinct Playwright-managed binary pinned to this Playwright version.',
        }),
      ),
      linkScope: Type.Optional(
        Type.String({
          description: 'Link filter: "all" (default), "internal", or "external". Used in navigation and links modes.',
        }),
      ),
      sameSiteOnly: Type.Optional(
        Type.Boolean({
          description: "When true, only keep links from the same site as the fetched page. Used in navigation and links modes.",
        }),
      ),
      maxCharacters: Type.Optional(
        Type.Integer({
          description: `Maximum number of characters to return (default ${DEFAULT_MAX_CHARACTERS}, hard cap ${MAX_ALLOWED_CHARACTERS}).`,
          minimum: 1,
          maximum: MAX_ALLOWED_CHARACTERS,
        }),
      ),
      preferMainContent: Type.Optional(
        Type.Boolean({
          description:
            "Prefer <main>, <article>, or <body> content when present before broader fallbacks. Defaults to true. Used in page mode.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      const url = normalizeUrl(params.url);
      const mode = normalizeMode(params.mode);
      const browserName = normalizeBrowser(params.browser);
      const linkScope = normalizeLinkScope(params.linkScope);
      const sameSiteOnly = params.sameSiteOnly ?? false;
      const maxCharacters = Math.min(params.maxCharacters ?? DEFAULT_MAX_CHARACTERS, MAX_ALLOWED_CHARACTERS);
      const preferMainContent = params.preferMainContent ?? true;

      // ── Acquire browser from pool (warm reuse or cold launch) ──────────
      const browser = await acquireBrowser(browserName, (msg) => {
        onUpdate?.({ content: [{ type: "text", text: msg }], details: undefined });
      });

      let rawBody: string;
      let finalUrl: string;
      let title: string;
      let statusCode: number | null = null;

      // Each request gets its own isolated BrowserContext (incognito-equivalent).
      // We close the context — not the browser — when done, leaving the browser
      // process alive for the next request.
      const context = await browser.newContext({
        userAgent:
          browserName === "chromium"
            ? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            : undefined,
      });

      try {
        // On abort: close just this context, not the shared browser.
        signal?.addEventListener("abort", () => { context.close().catch(() => {}); });

        const page = await context.newPage();

        // Capture HTTP status from the primary navigation response.
        page.on("response", (response) => {
          if (response.url() === url || response.url() === finalUrl) {
            statusCode = response.status();
          }
        });

        onUpdate?.({ content: [{ type: "text", text: `Navigating to ${url} (waiting for network idle)...` }], details: undefined });

        const response = await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
        if (response) statusCode = response.status();

        finalUrl = page.url();
        title = await page.title();
        rawBody = await page.content();
      } finally {
        await context.close();
        releaseBrowser(browserName);
      }

      // ── Process content ───────────────────────────────────────────────────
      onUpdate?.({ content: [{ type: "text", text: `Converting ${finalUrl} to Markdown...` }], details: undefined });

      let extractedFrom: ExtractedFrom = "document";
      let markdown = "";
      let linkCount = 0;
      let totalLinkCount = 0;
      let sectionCount = 0;
      let fallbackUsed = false;
      let keyLinksAdded = false;
      let keyLinkCount = 0;
      let assessment: ContentAssessment | undefined;

      if (mode === "raw") {
        extractedFrom = "document";
        markdown = rawBody;
      } else if (mode === "navigation") {
        extractedFrom = "navigation";
        const navigation = buildNavigationMarkdown(rawBody, finalUrl, { linkScope, sameSiteOnly });
        markdown = navigation.markdown;
        linkCount = navigation.linkCount;
        totalLinkCount = navigation.totalLinkCount;
        sectionCount = navigation.sectionCount;
      } else if (mode === "links") {
        extractedFrom = "links";
        const cleanedHtml = stripBoilerplateHtml(absolutizeAnchorHrefs(rawBody, finalUrl));
        const linkResult = extractLinks(cleanedHtml, finalUrl, { linkScope, sameSiteOnly });
        linkCount = linkResult.links.length;
        totalLinkCount = linkResult.totalLinkCount;
        markdown = buildLinksMarkdown(linkResult.links);
      } else {
        const page = buildPageMarkdown(rawBody, finalUrl, preferMainContent);
        extractedFrom = page.extractedFrom;
        markdown = page.markdown;
        fallbackUsed = page.fallbackUsed;
        keyLinksAdded = page.keyLinksAdded;
        keyLinkCount = page.keyLinkCount;
        assessment = page.assessment;
      }

      if (!markdown) {
        markdown =
          mode === "page"
            ? "_No readable content was extracted from this page._"
            : mode === "navigation"
              ? "_No navigation content or links were extracted from this page._"
              : mode === "links"
                ? "_No links matched the requested filters._"
                : "_No content returned._";
      }

      const truncated = truncateText(markdown, maxCharacters);

      const headerLines = [
        `Source: ${url}`,
        ...(finalUrl !== url ? [`Final URL: ${finalUrl}`] : []),
        ...(title ? [`Title: ${title}`] : []),
        `Mode: ${mode}`,
        `Browser: ${browserName}`,
        ...(statusCode !== null ? [`HTTP: ${statusCode}`] : []),
        ...(mode !== "raw" ? [`Extracted from: ${extractedFrom}`] : []),
        ...(mode === "page" && fallbackUsed ? ["Fallback used: broader body extraction"] : []),
        ...(mode === "page" && keyLinksAdded ? [`Key links added: ${keyLinkCount}`] : []),
        ...(mode === "page" && assessment
          ? [`Content words: ${assessment.wordCount}`, `Content score: ${assessment.score}`]
          : []),
        ...(mode === "navigation" || mode === "links"
          ? [`Link scope: ${linkScope}`, `Same site only: ${sameSiteOnly ? "yes" : "no"}`]
          : []),
        ...(mode === "navigation" ? [`Navigation sections: ${sectionCount}`] : []),
        ...(mode === "navigation" || mode === "links"
          ? [`Links returned: ${linkCount}`, `Total links seen: ${totalLinkCount}`]
          : []),
        ...(truncated.truncated
          ? [`Truncated: yes (${truncated.text.length}/${markdown.length} chars returned)`]
          : []),
      ];

      return {
        content: [{ type: "text", text: `${headerLines.join("\n")}\n\n---\n\n${truncated.text}` }],
        details: {
          url,
          finalUrl,
          title,
          mode,
          browser: browserName,
          linkScope,
          sameSiteOnly,
          statusCode,
          extractedFrom,
          sectionCount,
          linkCount,
          totalLinkCount,
          fallbackUsed,
          keyLinksAdded,
          keyLinkCount,
          assessment,
          markdownLength: markdown.length,
          returnedLength: truncated.text.length,
          truncated: truncated.truncated,
        },
      };
    },
  } as any;

  const browserOpenTool = {
    name: "browser_open",
    label: "Browser Open",
    description: "Open a URL in a persistent Playwright browser session for local web development and interactive debugging.",
    promptSnippet: "Open a URL in a persistent browser session and return a sessionId for further browser tools.",
    promptGuidelines: [
      "Use browser_open after starting a local web development server with bash.",
      "For localhost URLs, include the port; schemeless localhost URLs default to http://.",
      "Reuse the returned sessionId with browser_snapshot, browser_interact, browser_logs, and browser_screenshot.",
      "Use read_website_browser for content extraction; use browser_open and related browser_* tools for interactive app testing.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to open. localhost/127.0.0.1 URLs without a scheme default to http://; other schemeless URLs default to https://." }),
      sessionId: Type.Optional(Type.String({ description: "Existing browser session to reuse. If omitted, creates a new session." })),
      browser: Type.Optional(Type.String({ description: 'Browser engine: "chromium" (default), "firefox", or "webkit". Used only when creating a new session.' })),
      waitUntil: Type.Optional(Type.String({ description: 'Navigation wait condition: "domcontentloaded" (default), "load", or "networkidle".' })),
      timeoutMs: Type.Optional(Type.Integer({ description: "Navigation timeout in milliseconds. Default 30000.", minimum: 1 })),
      viewport: Type.Optional(Type.Object({ width: Type.Integer({ minimum: 1 }), height: Type.Integer({ minimum: 1 }) })),
      deviceScaleFactor: Type.Optional(Type.Integer({ description: "Device scale factor for new sessions.", minimum: 1 })),
      mobile: Type.Optional(Type.Boolean({ description: "When true, enable Playwright mobile emulation for new sessions." })),
      hasTouch: Type.Optional(Type.Boolean({ description: "When true, enable touch input support for new sessions." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const url = normalizeInteractiveUrl(params.url);
      const waitUntil = normalizeWaitUntil(params.waitUntil, "domcontentloaded");
      const timeout = params.timeoutMs ?? 30_000;
      let session: BrowserSession;
      if (params.sessionId) {
        session = getBrowserSession(params.sessionId);
      } else {
        const browserName = normalizeBrowser(params.browser);
        session = await createBrowserSession(browserName, params, (msg) => {
          onUpdate?.({ content: [{ type: "text", text: msg }], details: undefined });
        });
      }
      signal?.addEventListener("abort", () => { closeBrowserSession(session.id).catch(() => {}); });
      onUpdate?.({ content: [{ type: "text", text: `Navigating session ${session.id} to ${url}...` }], details: undefined });
      const response = await session.page.goto(url, { waitUntil, timeout });
      touchSession(session);
      const snapshot = await summarizeCurrentPage(session);
      const statusCode = response?.status() ?? null;
      return makeTextResult(`Session: ${session.id}\nBrowser: ${session.browserName}\nURL: ${session.page.url()}\nTitle: ${await session.page.title()}\nHTTP: ${statusCode ?? "unknown"}\nWaited for: ${waitUntil}\n\n---\n\n${snapshot}`, {
        sessionId: session.id,
        browser: session.browserName,
        url,
        finalUrl: session.page.url(),
        title: await session.page.title(),
        statusCode,
        waitUntil,
      });
    },
  } as any;

  const browserSnapshotTool = {
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description: "Inspect the current state of a persistent browser session as visible text and interactive elements.",
    promptSnippet: "Inspect the current page in a browser session before choosing what to click or type.",
    promptGuidelines: [
      "Use browser_snapshot after browser_open and after important interactions to understand current UI state.",
      "Prefer the default visible-elements mode for app testing; use html only when debugging DOM details.",
    ],
    parameters: Type.Object({
      sessionId: Type.String({ description: "Browser session ID returned by browser_open." }),
      mode: Type.Optional(Type.String({ description: 'Snapshot mode: "visible-elements" (default), "text", "html", or "accessibility".' })),
      maxCharacters: Type.Optional(Type.Integer({ description: `Maximum characters to return (default ${DEFAULT_SNAPSHOT_CHARACTERS}, hard cap ${MAX_ALLOWED_CHARACTERS}).`, minimum: 1, maximum: MAX_ALLOWED_CHARACTERS })),
    }),
    async execute(_toolCallId, params) {
      const session = getBrowserSession(params.sessionId);
      const mode = normalizeSnapshotMode(params.mode);
      const maxCharacters = Math.min(params.maxCharacters ?? DEFAULT_SNAPSHOT_CHARACTERS, MAX_ALLOWED_CHARACTERS);
      const snapshot = await buildSessionSnapshot(session.page, mode, maxCharacters);
      touchSession(session);
      return makeTextResult(snapshot, { sessionId: session.id, url: session.page.url(), title: await session.page.title(), mode });
    },
  } as any;

  const browserInteractTool = {
    name: "browser_interact",
    label: "Browser Interact",
    description: "Click, fill, type, press keys, select, check, uncheck, or hover in a persistent browser session.",
    promptSnippet: "Interact with a page using accessible locators such as role/name, label, placeholder, or testId.",
    promptGuidelines: [
      "Prefer role + name, label, placeholder, or testId locators before CSS selectors.",
      "Call browser_snapshot first if you are unsure which controls are visible.",
      "After interactions that should change UI state, inspect the returned summary or call browser_snapshot/browser_logs.",
    ],
    parameters: Type.Object({
      sessionId: Type.String({ description: "Browser session ID returned by browser_open." }),
      action: Type.String({ description: 'Action: "click", "fill", "type", "press", "select", "check", "uncheck", or "hover".' }),
      role: Type.Optional(Type.String({ description: "ARIA role for accessible locator, e.g. button, link, textbox." })),
      name: Type.Optional(Type.String({ description: "Accessible name to combine with role." })),
      label: Type.Optional(Type.String({ description: "Form label text." })),
      placeholder: Type.Optional(Type.String({ description: "Input placeholder text." })),
      testId: Type.Optional(Type.String({ description: "data-testid value." })),
      text: Type.Optional(Type.String({ description: "Visible text locator." })),
      css: Type.Optional(Type.String({ description: "CSS selector fallback." })),
      value: Type.Optional(Type.String({ description: "Value for fill/type/select." })),
      key: Type.Optional(Type.String({ description: "Key for press, e.g. Enter, Escape, Control+A." })),
      exact: Type.Optional(Type.Boolean({ description: "Whether text/name matching should be exact." })),
      nth: Type.Optional(Type.Integer({ description: "Zero-based index when locator intentionally matches multiple elements.", minimum: 0 })),
      timeoutMs: Type.Optional(Type.Integer({ description: "Action timeout in milliseconds. Default 10000.", minimum: 1 })),
    }),
    async execute(_toolCallId, params) {
      const session = getBrowserSession(params.sessionId);
      const action = String(params.action || "").trim().toLowerCase();
      const timeout = params.timeoutMs ?? 10_000;
      const targetRequired = action !== "press" || params.role || params.label || params.placeholder || params.testId || params.text || params.css;
      let locatorDescription = "page";
      if (targetRequired) {
        const resolved = await assertSingleLocator(session.page, params);
        locatorDescription = `${resolved.description}${resolved.count > 1 ? ` nth=${params.nth}` : ""}`;
        if (action === "click") await resolved.locator.click({ timeout });
        else if (action === "fill") await resolved.locator.fill(params.value ?? "", { timeout });
        else if (action === "type") await resolved.locator.type(params.value ?? "", { timeout });
        else if (action === "press") {
          if (!params.key) throw new Error("key is required for press");
          await resolved.locator.press(params.key, { timeout });
        } else if (action === "select") {
          if (params.value === undefined) throw new Error("value is required for select");
          await resolved.locator.selectOption(params.value, { timeout });
        } else if (action === "check") await resolved.locator.check({ timeout });
        else if (action === "uncheck") await resolved.locator.uncheck({ timeout });
        else if (action === "hover") await resolved.locator.hover({ timeout });
        else throw new Error('Invalid action. Expected "click", "fill", "type", "press", "select", "check", "uncheck", or "hover".');
      } else {
        if (action !== "press") throw new Error("A locator is required for this action.");
        if (!params.key) throw new Error("key is required for press");
        await session.page.keyboard.press(params.key);
      }
      touchSession(session);
      const snapshot = await summarizeCurrentPage(session);
      const recentProblems = [
        ...session.pageErrors.slice(-3).map((e) => `Page error: ${e.text}`),
        ...session.consoleEntries.filter((e) => e.type === "error").slice(-3).map((e) => `Console error: ${e.text}`),
        ...session.networkEntries.slice(-3).map((e) => `Network ${e.status ?? "failed"}: ${e.method} ${e.url}`),
      ];
      return makeTextResult(`Action: ${action}\nLocator: ${locatorDescription}\nSession: ${session.id}\nURL: ${session.page.url()}\nTitle: ${await session.page.title()}${recentProblems.length ? `\n\nRecent problems:\n${recentProblems.map((p) => `- ${p}`).join("\n")}` : ""}\n\n---\n\n${snapshot}`, {
        sessionId: session.id,
        action,
        locator: locatorDescription,
        url: session.page.url(),
        title: await session.page.title(),
      });
    },
  } as any;

  const browserLogsTool = {
    name: "browser_logs",
    label: "Browser Logs",
    description: "Read console messages, page errors, failed requests, and HTTP error responses captured for a browser session.",
    promptSnippet: "Inspect browser console, page errors, and network failures for a browser session.",
    promptGuidelines: ["Use browser_logs when debugging blank screens, failed interactions, or local app errors."],
    parameters: Type.Object({
      sessionId: Type.String({ description: "Browser session ID returned by browser_open." }),
      sinceLastCall: Type.Optional(Type.Boolean({ description: "When true, return only entries not returned by the previous browser_logs call." })),
      includeConsole: Type.Optional(Type.Boolean({ description: "Include console messages. Defaults true." })),
      includePageErrors: Type.Optional(Type.Boolean({ description: "Include uncaught page errors. Defaults true." })),
      includeNetwork: Type.Optional(Type.Boolean({ description: "Include failed requests and HTTP 4xx/5xx responses. Defaults true." })),
      maxEntries: Type.Optional(Type.Integer({ description: `Maximum entries per category. Default ${DEFAULT_LOG_ENTRIES}.`, minimum: 1 })),
    }),
    async execute(_toolCallId, params) {
      const session = getBrowserSession(params.sessionId);
      const maxEntries = params.maxEntries ?? DEFAULT_LOG_ENTRIES;
      const since = params.sinceLastCall ?? false;
      const consoleEntries = (params.includeConsole ?? true) ? session.consoleEntries.slice(since ? session.lastConsoleCursor : 0).slice(-maxEntries) : [];
      const pageErrors = (params.includePageErrors ?? true) ? session.pageErrors.slice(since ? session.lastPageErrorCursor : 0).slice(-maxEntries) : [];
      const networkEntries = (params.includeNetwork ?? true) ? session.networkEntries.slice(since ? session.lastNetworkCursor : 0).slice(-maxEntries) : [];
      if (since) {
        session.lastConsoleCursor = session.consoleEntries.length;
        session.lastPageErrorCursor = session.pageErrors.length;
        session.lastNetworkCursor = session.networkEntries.length;
      }
      touchSession(session);
      const parts: string[] = [`Session: ${session.id}`, `URL: ${session.page.url()}`, `Title: ${await session.page.title()}`];
      parts.push("\n## Console");
      parts.push(consoleEntries.length ? consoleEntries.map((e) => `- [${e.type}] ${e.text}`).join("\n") : "_No console entries._");
      parts.push("\n## Page errors");
      parts.push(pageErrors.length ? pageErrors.map((e) => `- ${e.text}`).join("\n") : "_No page errors._");
      parts.push("\n## Network errors");
      parts.push(networkEntries.length ? networkEntries.map((e) => `- ${e.status ?? "failed"} ${e.method} ${e.url}${e.failure ? ` — ${e.failure}` : ""}`).join("\n") : "_No failed requests or HTTP error responses._");
      return makeTextResult(truncateText(parts.join("\n"), MAX_ALLOWED_CHARACTERS).text, {
        sessionId: session.id,
        consoleCount: consoleEntries.length,
        pageErrorCount: pageErrors.length,
        networkCount: networkEntries.length,
      });
    },
  } as any;

  const browserScreenshotTool = {
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: "Save a screenshot of a persistent browser session to disk and return the file path.",
    promptSnippet: "Capture a screenshot when visual layout or rendered appearance matters.",
    parameters: Type.Object({
      sessionId: Type.String({ description: "Browser session ID returned by browser_open." }),
      fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page. Defaults false." })),
      path: Type.Optional(Type.String({ description: "Optional output path. Defaults to the session artifact directory under /tmp/pi-playwright-web." })),
    }),
    async execute(_toolCallId, params) {
      const session = getBrowserSession(params.sessionId);
      const screenshotPath = params.path || join(session.artifactDir, `screenshot-${String(++session.screenshotCount).padStart(3, "0")}.png`);
      mkdirSync(dirname(screenshotPath), { recursive: true });
      await session.page.screenshot({ path: screenshotPath, fullPage: params.fullPage ?? false });
      touchSession(session);
      return makeTextResult(`Screenshot saved: ${screenshotPath}\nSession: ${session.id}\nURL: ${session.page.url()}\nTitle: ${await session.page.title()}`, {
        sessionId: session.id,
        path: screenshotPath,
        url: session.page.url(),
        title: await session.page.title(),
      });
    },
  } as any;

  const browserWaitTool = {
    name: "browser_wait",
    label: "Browser Wait",
    description: "Wait for page load states, selectors, text, URL changes, or a fixed timeout in a persistent browser session.",
    promptSnippet: "Wait for async UI changes, route changes, selectors, or text before taking the next browser action.",
    promptGuidelines: [
      "Use browser_wait after actions that trigger asynchronous UI updates or navigation.",
      "Prefer waiting for specific text or selectors over fixed timeouts.",
    ],
    parameters: Type.Object({
      sessionId: Type.String({ description: "Browser session ID returned by browser_open." }),
      for: Type.String({ description: 'Condition to wait for: "load", "domcontentloaded", "networkidle", "selector", "text", "url", or "timeout".' }),
      selector: Type.Optional(Type.String({ description: "CSS selector to wait for when for=selector." })),
      text: Type.Optional(Type.String({ description: "Visible text to wait for when for=text." })),
      urlPattern: Type.Optional(Type.String({ description: "URL glob string or regular expression source to wait for when for=url." })),
      exact: Type.Optional(Type.Boolean({ description: "Whether text matching should be exact. Used when for=text." })),
      timeoutMs: Type.Optional(Type.Integer({ description: "Wait timeout in milliseconds. Default 10000.", minimum: 1 })),
    }),
    async execute(_toolCallId, params) {
      const session = getBrowserSession(params.sessionId);
      const condition = String(params.for || "").trim().toLowerCase();
      const timeout = params.timeoutMs ?? 10_000;
      if (condition === "load" || condition === "domcontentloaded" || condition === "networkidle") {
        await session.page.waitForLoadState(condition as WaitUntil, { timeout });
      } else if (condition === "selector") {
        if (!params.selector) throw new Error("selector is required when for=selector");
        await session.page.waitForSelector(params.selector, { state: "visible", timeout });
      } else if (condition === "text") {
        if (!params.text) throw new Error("text is required when for=text");
        await session.page.getByText(params.text, { exact: params.exact ?? false }).first().waitFor({ state: "visible", timeout });
      } else if (condition === "url") {
        if (!params.urlPattern) throw new Error("urlPattern is required when for=url");
        let pattern: string | RegExp = params.urlPattern;
        if (params.urlPattern.startsWith("/") && params.urlPattern.lastIndexOf("/") > 0) {
          const lastSlash = params.urlPattern.lastIndexOf("/");
          pattern = new RegExp(params.urlPattern.slice(1, lastSlash), params.urlPattern.slice(lastSlash + 1));
        }
        await session.page.waitForURL(pattern as any, { timeout });
      } else if (condition === "timeout") {
        await session.page.waitForTimeout(timeout);
      } else {
        throw new Error('Invalid wait condition. Expected "load", "domcontentloaded", "networkidle", "selector", "text", "url", or "timeout".');
      }
      touchSession(session);
      const snapshot = await summarizeCurrentPage(session);
      return makeTextResult(`Waited for: ${condition}\nSession: ${session.id}\nURL: ${session.page.url()}\nTitle: ${await session.page.title()}\n\n---\n\n${snapshot}`, {
        sessionId: session.id,
        condition,
        url: session.page.url(),
        title: await session.page.title(),
      });
    },
  } as any;

  const browserEvalTool = {
    name: "browser_eval",
    label: "Browser Eval",
    description: "Execute JavaScript in the current page of a persistent browser session and return a bounded serialized result.",
    promptSnippet: "Run JavaScript in the page for advanced debugging when snapshots and normal interactions are insufficient.",
    promptGuidelines: [
      "Prefer browser_snapshot and browser_interact first; use browser_eval for advanced inspection only.",
      "Keep expressions small and side-effect-free unless intentionally debugging page behavior.",
    ],
    parameters: Type.Object({
      sessionId: Type.String({ description: "Browser session ID returned by browser_open." }),
      expression: Type.String({ description: "JavaScript expression to evaluate in the page context." }),
      timeoutMs: Type.Optional(Type.Integer({ description: "Evaluation timeout in milliseconds. Default 5000.", minimum: 1 })),
      maxCharacters: Type.Optional(Type.Integer({ description: `Maximum characters to return (default ${DEFAULT_SNAPSHOT_CHARACTERS}, hard cap ${MAX_ALLOWED_CHARACTERS}).`, minimum: 1, maximum: MAX_ALLOWED_CHARACTERS })),
    }),
    async execute(_toolCallId, params) {
      const session = getBrowserSession(params.sessionId);
      const timeout = params.timeoutMs ?? 5_000;
      const maxCharacters = Math.min(params.maxCharacters ?? DEFAULT_SNAPSHOT_CHARACTERS, MAX_ALLOWED_CHARACTERS);
      const value = await withTimeout(
        session.page.evaluate((expression) => (0, eval)(expression), params.expression),
        timeout,
        "browser_eval",
      );
      touchSession(session);
      const result = formatEvalValue(value, maxCharacters);
      return makeTextResult(`Session: ${session.id}\nURL: ${session.page.url()}\nTitle: ${await session.page.title()}\nExpression:\n\n\`\`\`js\n${params.expression}\n\`\`\`\n\nResult:\n\n\`\`\`json\n${result}\n\`\`\``, {
        sessionId: session.id,
        url: session.page.url(),
        title: await session.page.title(),
        returnedLength: result.length,
      });
    },
  } as any;

  const browserAssertTool = {
    name: "browser_assert",
    label: "Browser Assert",
    description: "Run a lightweight UI assertion against a persistent browser session.",
    promptSnippet: "Assert visible text, selector visibility, URL, or title when validating web app behavior.",
    parameters: Type.Object({
      sessionId: Type.String({ description: "Browser session ID returned by browser_open." }),
      assertion: Type.String({ description: 'Assertion: "text-visible", "text-not-visible", "selector-visible", "selector-not-visible", "url-matches", or "title-matches".' }),
      text: Type.Optional(Type.String({ description: "Text for text-visible/text-not-visible." })),
      selector: Type.Optional(Type.String({ description: "CSS selector for selector-visible/selector-not-visible." })),
      pattern: Type.Optional(Type.String({ description: "Regular expression source for url-matches/title-matches." })),
      exact: Type.Optional(Type.Boolean({ description: "Whether text matching should be exact." })),
      timeoutMs: Type.Optional(Type.Integer({ description: "Assertion timeout in milliseconds. Default 5000.", minimum: 1 })),
    }),
    async execute(_toolCallId, params) {
      const session = getBrowserSession(params.sessionId);
      const assertion = String(params.assertion || "").trim().toLowerCase();
      const timeout = params.timeoutMs ?? 5_000;
      if (assertion === "text-visible") {
        if (!params.text) throw new Error("text is required for text-visible");
        await session.page.getByText(params.text, { exact: params.exact ?? false }).first().waitFor({ state: "visible", timeout });
      } else if (assertion === "text-not-visible") {
        if (!params.text) throw new Error("text is required for text-not-visible");
        await session.page.getByText(params.text, { exact: params.exact ?? false }).first().waitFor({ state: "hidden", timeout });
      } else if (assertion === "selector-visible") {
        if (!params.selector) throw new Error("selector is required for selector-visible");
        await session.page.locator(params.selector).first().waitFor({ state: "visible", timeout });
      } else if (assertion === "selector-not-visible") {
        if (!params.selector) throw new Error("selector is required for selector-not-visible");
        await session.page.locator(params.selector).first().waitFor({ state: "hidden", timeout });
      } else if (assertion === "url-matches") {
        if (!params.pattern) throw new Error("pattern is required for url-matches");
        const regex = new RegExp(params.pattern);
        await withTimeout(session.page.waitForFunction((source) => new RegExp(source).test((globalThis as any).location.href), params.pattern), timeout, "url-matches");
        if (!regex.test(session.page.url())) throw new Error(`URL did not match /${params.pattern}/: ${session.page.url()}`);
      } else if (assertion === "title-matches") {
        if (!params.pattern) throw new Error("pattern is required for title-matches");
        await withTimeout(session.page.waitForFunction((source) => new RegExp(source).test((globalThis as any).document.title), params.pattern), timeout, "title-matches");
      } else {
        throw new Error('Invalid assertion. Expected "text-visible", "text-not-visible", "selector-visible", "selector-not-visible", "url-matches", or "title-matches".');
      }
      touchSession(session);
      return makeTextResult(`Assertion passed: ${assertion}\nSession: ${session.id}\nURL: ${session.page.url()}\nTitle: ${await session.page.title()}`, {
        sessionId: session.id,
        assertion,
        passed: true,
        url: session.page.url(),
        title: await session.page.title(),
      });
    },
  } as any;

  const browserCloseTool = {
    name: "browser_close",
    label: "Browser Close",
    description: "Close a persistent browser session and release its browser context.",
    promptSnippet: "Close a browser session when finished with local web development testing.",
    parameters: Type.Object({ sessionId: Type.String({ description: "Browser session ID returned by browser_open." }) }),
    async execute(_toolCallId, params) {
      const closed = await closeBrowserSession(params.sessionId);
      return makeTextResult(closed ? `Closed browser session: ${params.sessionId}` : `No such browser session: ${params.sessionId}`, { sessionId: params.sessionId, closed });
    },
  } as any;

  const browserListSessionsTool = {
    name: "browser_list_sessions",
    label: "Browser List Sessions",
    description: "List active persistent browser sessions.",
    promptSnippet: "List active browser sessions and their current URLs.",
    parameters: Type.Object({}),
    async execute() {
      const entries = Array.from(sessions.values());
      const lines = entries.length ? await Promise.all(entries.map(async (s) => `- ${s.id} ${s.browserName} ${s.page.url()} — ${await s.page.title()}`)) : ["_No active browser sessions._"];
      return makeTextResult(["# Active browser sessions", ...lines].join("\n"), { count: entries.length, sessions: entries.map((s) => ({ id: s.id, browser: s.browserName, url: s.page.url(), createdAt: s.createdAt, lastUsedAt: s.lastUsedAt })) });
    },
  } as any;

  pi.registerTool(tool);
  pi.registerTool(browserOpenTool);
  pi.registerTool(browserSnapshotTool);
  pi.registerTool(browserInteractTool);
  pi.registerTool(browserLogsTool);
  pi.registerTool(browserScreenshotTool);
  pi.registerTool(browserWaitTool);
  pi.registerTool(browserEvalTool);
  pi.registerTool(browserAssertTool);
  pi.registerTool(browserCloseTool);
  pi.registerTool(browserListSessionsTool);
}
