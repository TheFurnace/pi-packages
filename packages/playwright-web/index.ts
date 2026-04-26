import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync } from "fs";
import { chromium, firefox, webkit } from "playwright";
import type { BrowserType } from "playwright";
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

// ─── Browser resolution ──────────────────────────────────────────────────────

const BROWSER_TYPES: Record<BrowserName, BrowserType> = { chromium, firefox, webkit };

/**
 * Ensure the Playwright-managed binary for the given browser is installed,
 * downloading it programmatically if needed (no CLI, no npx).
 * Throws a clear error if installation fails.
 */
async function ensureBrowser(browserName: BrowserName, onUpdate: (msg: string) => void): Promise<void> {
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

// ─── Extension entry point ───────────────────────────────────────────────────

function normalizeBrowser(input?: string): BrowserName {
  const name = (input ?? "chromium").trim().toLowerCase();
  if (name === "chromium" || name === "firefox" || name === "webkit") return name as BrowserName;
  throw new Error('Invalid browser. Expected "chromium", "firefox", or "webkit".');
}

export default function playwrightWebExtension(pi: ExtensionAPI) {
  pi.registerTool({
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

      // ── Ensure browser binary is installed ───────────────────────────────
      await ensureBrowser(browserName, (msg) => {
        onUpdate?.({ content: [{ type: "text", text: msg }] });
      });

      onUpdate?.({ content: [{ type: "text", text: `Launching headless ${browserName} for ${url}...` }] });

      // ── Launch browser ────────────────────────────────────────────────────
      const browserType = BROWSER_TYPES[browserName];
      const browser = await browserType.launch({
        headless: true,
        ...(browserName === "chromium" ? { args: ["--no-sandbox", "--disable-setuid-sandbox"] } : {}),
      });

      let rawBody: string;
      let finalUrl: string;
      let title: string;
      let statusCode: number | null = null;

      try {
        const context = await browser.newContext({
          userAgent:
            browserName === "chromium"
              ? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
              : undefined,
        });

        // Abort the whole thing if the AbortSignal fires
        signal?.addEventListener("abort", () => { browser.close().catch(() => {}); });

        const page = await context.newPage();

        // Capture HTTP status from the primary navigation response
        page.on("response", (response) => {
          if (response.url() === url || response.url() === finalUrl) {
            statusCode = response.status();
          }
        });

      onUpdate?.({ content: [{ type: "text", text: `Navigating to ${url} (waiting for network idle)...` }] });

        const response = await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
        if (response) statusCode = response.status();

        finalUrl = page.url();
        title = await page.title();
        rawBody = await page.content();
      } finally {
        await browser.close();
      }

      // ── Process content ───────────────────────────────────────────────────
      onUpdate?.({ content: [{ type: "text", text: `Converting ${finalUrl} to Markdown...` }] });

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
  });
}
