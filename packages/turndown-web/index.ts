import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import TurndownService from "turndown";
import TurndownPluginGfm from "turndown-plugin-gfm";
import { Type } from "typebox";

const DEFAULT_MAX_CHARACTERS = 20_000;
const MAX_ALLOWED_CHARACTERS = 100_000;
const DEFAULT_KEY_LINK_LIMIT = 8;

const { gfm } = TurndownPluginGfm as { gfm?: (service: TurndownService) => void };

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

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("URL is required");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function isProbablyHtml(contentType: string, body: string): boolean {
  if (/html|xhtml|xml/i.test(contentType)) return true;
  return /<html\b|<body\b|<main\b|<article\b|<!doctype html/i.test(body);
}

function normalizeMode(input?: string): ReadMode {
  const mode = (input ?? "page").trim().toLowerCase();
  if (mode === "page" || mode === "navigation" || mode === "links" || mode === "raw") {
    return mode;
  }
  throw new Error('Invalid mode. Expected "page", "navigation", "links", or "raw".');
}

function normalizeLinkScope(input?: string): LinkScope {
  const scope = (input ?? "all").trim().toLowerCase();
  if (scope === "all" || scope === "internal" || scope === "external") {
    return scope;
  }
  throw new Error('Invalid linkScope. Expected "all", "internal", or "external".');
}

function extractPreferredFragment(html: string): { html: string; extractedFrom: ExtractedFrom } {
  const patterns: Array<{ extractedFrom: Exclude<ExtractedFrom, "document" | "navigation" | "links">; pattern: RegExp }> = [
    { extractedFrom: "main", pattern: /<main\b[^>]*>([\s\S]*?)<\/main>/i },
    { extractedFrom: "article", pattern: /<article\b[^>]*>([\s\S]*?)<\/article>/i },
    { extractedFrom: "body", pattern: /<body\b[^>]*>([\s\S]*?)<\/body>/i },
  ];

  for (const candidate of patterns) {
    const match = html.match(candidate.pattern);
    if (match?.[1]) {
      return { html: match[1], extractedFrom: candidate.extractedFrom };
    }
  }

  return { html, extractedFrom: "document" };
}

function extractBodyFragment(html: string): { html: string; extractedFrom: ExtractedFrom } {
  const match = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (match?.[1]) {
    return { html: match[1], extractedFrom: "body" };
  }
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

function normalizeInlineWhitespace(text: string): string {
  return decodeBasicEntities(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function separateAdjacentAnchors(html: string): string {
  return html.replace(/<\/a>\s*(<a\b)/gi, "</a> $1");
}

function sanitizeNavigationSectionHtml(html: string, baseUrl: string): string {
  return separateAdjacentAnchors(
    absolutizeAnchorHrefs(html, baseUrl).replace(/<a\b([^>]*)href=(['"])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi, (_match, before, quote, href, after, inner) => {
      const attrs = `${before ?? ""} ${after ?? ""}`;
      const label = normalizeInlineWhitespace(
        stripTagsToText(inner ?? "")
        || extractAttribute(attrs, "aria-label")
        || extractAttribute(attrs, "title")
        || "",
      );
      if (!label) return "";
      return `<a href=${quote}${normalizeHref(baseUrl, href)}${quote}>${label}</a>`;
    }),
  );
}

function extractNavigationSections(html: string, baseUrl: string): NavigationSection[] {
  const sections: NavigationSection[] = [];

  for (const tag of ["nav", "header", "aside", "footer"] as const) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
    for (const match of html.matchAll(pattern)) {
      const fragment = match[1]?.trim();
      if (!fragment) continue;
      sections.push({
        tag,
        html: sanitizeNavigationSectionHtml(fragment, baseUrl),
      });
    }
  }

  return sections;
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

function isIpAddress(hostname: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(":");
}

function getSiteKey(hostname: string): string {
  const normalized = hostname.toLowerCase();
  if (!normalized || normalized === "localhost" || isIpAddress(normalized)) {
    return normalized;
  }

  const parts = normalized.split(".").filter(Boolean);
  if (parts.length <= 2) {
    return normalized;
  }

  return parts.slice(-2).join(".");
}

function isInternalLink(href: string, baseUrl: string): boolean {
  try {
    const base = new URL(baseUrl);
    const target = new URL(href, baseUrl);
    return target.hostname === base.hostname;
  } catch {
    return false;
  }
}

function isSameSiteLink(href: string, baseUrl: string): boolean {
  try {
    const base = new URL(baseUrl);
    const target = new URL(href, baseUrl);
    return getSiteKey(target.hostname) === getSiteKey(base.hostname);
  } catch {
    return false;
  }
}

function filterLinks(links: ExtractedLink[], baseUrl: string, options: LinkFilterOptions): ExtractedLink[] {
  return links.filter((link) => {
    const internal = isInternalLink(link.href, baseUrl);
    const sameSite = isSameSiteLink(link.href, baseUrl);

    if (options.linkScope === "internal" && !internal) return false;
    if (options.linkScope === "external" && internal) return false;
    if (options.sameSiteOnly && !sameSite) return false;

    return true;
  });
}

function extractLinks(html: string, baseUrl: string, options: LinkFilterOptions): { links: ExtractedLink[]; totalLinkCount: number } {
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
  if (links.length === 0) {
    return "_No links matched the requested filters._";
  }

  return cleanupMarkdown([
    "# Links",
    ...links.map((link) => `- [${link.text}](${link.href})`),
  ].join("\n\n"));
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
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !part.startsWith("#"))
    .length;
  const headingCount = (markdown.match(/^#{1,6}\s+/gm) ?? []).length;
  const linkCount = (markdown.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length;

  const score =
    textLength
    + paragraphCount * 180
    + headingCount * 120
    - linkCount * 40;

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

  if (gfm) {
    service.use(gfm);
  }

  return service;
}

function buildPageCandidate(fragmentHtml: string, baseUrl: string, extractedFrom: ExtractedFrom): PageCandidate {
  const cleanedHtml = stripContentChrome(separateAdjacentAnchors(absolutizeAnchorHrefs(fragmentHtml, baseUrl)));
  let markdown = cleanupMarkdown(buildTurndownService().turndown(cleanedHtml));

  if (!markdown) {
    markdown = stripTagsToText(cleanedHtml);
  }

  markdown = cleanupMarkdown(normalizeMarkdownLinks(markdown, baseUrl));
  return {
    markdown,
    extractedFrom,
    assessment: assessMarkdown(markdown),
  };
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

function buildKeyLinksSection(html: string, baseUrl: string, limit = DEFAULT_KEY_LINK_LIMIT): { markdown: string; count: number } {
  const cleanedHtml = stripBoilerplateHtml(absolutizeAnchorHrefs(html, baseUrl));
  const { links } = extractLinks(cleanedHtml, baseUrl, { linkScope: "internal", sameSiteOnly: true });
  const currentPage = stripHash(baseUrl);
  const selected = links
    .filter((link) => stripHash(link.href) !== currentPage)
    .filter((link) => link.text.length >= 2 && link.text.length <= 90)
    .slice(0, limit);

  if (selected.length === 0) {
    return { markdown: "", count: 0 };
  }

  return {
    markdown: cleanupMarkdown([
      "## Key links",
      ...selected.map((link) => `- [${link.text}](${link.href})`),
    ].join("\n\n")),
    count: selected.length,
  };
}

function buildPageMarkdown(html: string, baseUrl: string, preferMainContent: boolean): PageResult {
  const preferredFragment = preferMainContent
    ? extractPreferredFragment(html)
    : extractBodyFragment(html);

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

  if (links.length > 0) {
    parts.push(buildLinksMarkdown(links));
  }

  const markdown = cleanupMarkdown(parts.join("\n\n")) || "_No navigation content or links were extracted from this page._";
  return { markdown, linkCount: links.length, totalLinkCount, sectionCount: sections.length };
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = decodeBasicEntities((match?.[1] ?? "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return title || undefined;
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

function stripTagsToText(html: string): string {
  return normalizeInlineWhitespace(html.replace(/<[^>]+>/g, " "));
}

function cleanupMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateText(text: string, maxCharacters: number): { text: string; truncated: boolean } {
  if (text.length <= maxCharacters) {
    return { text, truncated: false };
  }

  const slice = text.slice(0, maxCharacters);
  const breakIndex = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
  const cutoff = breakIndex > Math.floor(maxCharacters * 0.6) ? breakIndex : maxCharacters;

  return {
    text: `${slice.slice(0, cutoff).trimEnd()}\n\n…[truncated]`,
    truncated: true,
  };
}

export default function turndownWebExtension(pi: ExtensionAPI) {
  const tool = {
    name: "read_website",
    label: "Read Website",
    description: "Fetch a web page over HTTP(S) and convert its HTML to Markdown for general page reading, navigation inspection, or link extraction.",
    promptSnippet: "Fetch an HTTP(S) page and convert it to Markdown for page reading, navigation extraction, or filtered link extraction.",
    promptGuidelines: [
      "Use read_website when the user asks you to inspect a live website or online documentation that is not already available in local files.",
      "Use read_website with its default page mode for most web-reading tasks.",
      "Use read_website with mode navigation when the user wants menus, site structure, navigational chrome, or grouped links rather than the main article body.",
      "Use read_website with mode links when the user wants only the page's links, optionally filtered to internal or external links.",
      "Use read_website with mode raw as a fallback for Single Page Applications (SPAs) to inspect raw HTML, embedded JSON, or find API endpoints when standard page extraction fails.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "HTTP or HTTPS URL to fetch. If no scheme is provided, https:// is assumed." }),
      mode: Type.Optional(
        Type.String({
          description: 'Read mode: "page" (default) for the most useful readable page content, "navigation" for nav/header/footer/aside content plus links, "links" for just links, or "raw" for raw HTML.',
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
          description: `Maximum number of Markdown characters to return (default ${DEFAULT_MAX_CHARACTERS}, hard cap ${MAX_ALLOWED_CHARACTERS}).`,
          minimum: 1,
          maximum: MAX_ALLOWED_CHARACTERS,
        }),
      ),
      preferMainContent: Type.Optional(
        Type.Boolean({
          description: "Prefer <main>, <article>, or <body> content when present before broader fallbacks. Defaults to true. Used in page mode.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const url = normalizeUrl(params.url);
      const mode = normalizeMode(params.mode);
      const linkScope = normalizeLinkScope(params.linkScope);
      const sameSiteOnly = params.sameSiteOnly ?? false;
      const maxCharacters = Math.min(params.maxCharacters ?? DEFAULT_MAX_CHARACTERS, MAX_ALLOWED_CHARACTERS);
      const preferMainContent = params.preferMainContent ?? true;

      onUpdate?.({
        content: [{ type: "text", text: `Fetching ${url}...` }],
        details: undefined,
      });

      const response = await fetch(url, {
        headers: {
          accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.1",
          "user-agent": "pi-agent-turndown-web/0.1.0",
        },
        redirect: "follow",
        signal,
      });

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`);
      }

      const finalUrl = response.url || url;
      const contentType = response.headers.get("content-type") ?? "";
      const rawBody = await response.text();
      const title = extractTitle(rawBody);

      let extractedFrom: ExtractedFrom = "document";
      let markdown = "";
      let linkCount = 0;
      let totalLinkCount = 0;
      let sectionCount = 0;
      let fallbackUsed = false;
      let keyLinksAdded = false;
      let keyLinkCount = 0;
      let assessment: ContentAssessment | undefined;

      if (isProbablyHtml(contentType, rawBody)) {
        onUpdate?.({
          content: [{ type: "text", text: `Converting ${finalUrl} to Markdown with Turndown...` }],
          details: undefined,
        });

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
      } else {
        markdown = cleanupMarkdown(rawBody);
      }

      if (!markdown) {
        markdown = mode === "page"
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
        `HTTP: ${response.status} ${response.statusText}`,
        ...(contentType ? [`Content-Type: ${contentType.split(";")[0]}`] : []),
        ...(isProbablyHtml(contentType, rawBody) && mode !== "raw" ? [`Extracted from: ${extractedFrom}`] : []),
        ...(mode === "page" && fallbackUsed ? ["Fallback used: broader body extraction"] : []),
        ...(mode === "page" && keyLinksAdded ? [`Key links added: ${keyLinkCount}`] : []),
        ...(mode === "page" && assessment ? [`Content words: ${assessment.wordCount}`, `Content score: ${assessment.score}`] : []),
        ...(mode === "navigation" || mode === "links" ? [`Link scope: ${linkScope}`, `Same site only: ${sameSiteOnly ? "yes" : "no"}`] : []),
        ...(mode === "navigation" ? [`Navigation sections: ${sectionCount}`] : []),
        ...(mode === "navigation" || mode === "links" ? [`Links returned: ${linkCount}`, `Total links seen: ${totalLinkCount}`] : []),
        ...(truncated.truncated ? [`Truncated: yes (${truncated.text.length}/${markdown.length} chars returned)`] : []),
      ];

      return {
        content: [{ type: "text", text: `${headerLines.join("\n")}\n\n---\n\n${truncated.text}` }],
        details: {
          url,
          finalUrl,
          title,
          mode,
          linkScope,
          sameSiteOnly,
          status: response.status,
          statusText: response.statusText,
          contentType,
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

  pi.registerTool(tool);
}
