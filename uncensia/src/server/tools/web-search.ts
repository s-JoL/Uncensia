import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { nextCitationId } from "./citation-id.ts";
import {
  COUNTRY_DESCRIPTION,
  FETCH_URL_DESCRIPTION,
  INTENT_DESCRIPTION,
  QUERY_DESCRIPTION,
  READ_PAGES_DESCRIPTION,
  WEB_SEARCH_DESCRIPTION,
} from "./descriptions.ts";

export interface WebRow {
  title: string;
  url: string;
  content: string;
  published_date?: string;
  source: string;
}

/** One call to a search backend: the tool's arguments, already validated. */
export interface WebSearchQuery {
  query: string;
  topic: "general" | "news";
  /** Ask for image results alongside the text ones. */
  images: boolean;
  maxResults: number;
  /** Date range as the schema spells it: `h`, `d`, `w`, `m` or `y`. */
  date?: string;
  country?: string;
}

export interface WebSearchContext {
  apiKey: string;
  /** Instance root for self-hosted backends. Ignored by Tavily. */
  baseUrl: string;
  signal?: AbortSignal;
}

export interface WebSearchResult {
  rows: WebRow[];
  /** Whatever the backend calls an image result, passed through untouched. */
  images: unknown[];
}

/**
 * One interface for everything that answers a query, mirroring the generation
 * adapters (`src/server/generation/`). A second backend — Brave, SearXNG, Exa,
 * an OpenAI-compatible search relay — is one object registered in `ADAPTERS`,
 * because everything above this line is the tool's schema and output format,
 * which `04-capabilities.md §1` fixes regardless of who answers.
 */
export interface WebSearchAdapter {
  /** Matches `capabilities.web.provider`, so the configuration names its adapter. */
  readonly id: string;
  /** False for a self-hosted backend that authenticates by being reachable. */
  readonly requiresKey: boolean;
  search(query: WebSearchQuery, ctx: WebSearchContext): Promise<WebSearchResult>;
  /**
   * The body of pages the search returned, keyed by url. Optional, because a
   * backend without an extraction endpoint should still be usable: the tool then
   * offers snippets, which is what it offered before any of this existed.
   */
  extract?(urls: string[], ctx: WebSearchContext): Promise<Map<string, string>>;
  /**
   * The same endpoint asked for on its own by `fetch_url`, where the page *is*
   * the answer and a failure must be reported, not swallowed into an empty map.
   */
  fetchPages?(urls: string[], ctx: WebSearchContext): Promise<FetchedPages>;
}

export interface FetchedPages {
  pages: Map<string, string>;
  failed: Array<{ url: string; error: string }>;
}

const hostname = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

const toRow = (item: Record<string, unknown>): WebRow => ({
  title: String(item.title ?? ""),
  url: String(item.url ?? ""),
  content: String(item.content ?? ""),
  published_date: item.published_date as string | undefined,
  source: hostname(String(item.url ?? "")),
});

const TAVILY_URL = process.env.TAVILY_SEARCH_URL || "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL = process.env.TAVILY_EXTRACT_URL || "https://api.tavily.com/extract";

function normalizeDateRange(value?: string) {
  if (value == null) return undefined;
  return ({ h: "day", d: "day", w: "week", m: "month", y: "year" } as Record<string, string>)[value];
}

/**
 * Tavily wants a country's English name where the schema asks for a code, so a
 * code is expanded through Intl and anything else is passed along as written.
 *
 * There used to be a patch table underneath this — `uk`, `cz`, `tr` and five
 * more spelled the way Tavily happened to spell them. It was eight countries
 * out of two hundred, which is not a mapping so much as a record of which ones
 * someone had tried. The model already knows what a country is called; if it
 * writes the name, that name is what gets sent.
 */
function normalizeTavilyCountry(value?: string) {
  const country = value?.trim().toLowerCase();
  if (!country) return undefined;
  if (!/^[a-z]{2}$/.test(country)) return country;
  return new Intl.DisplayNames(["en"], { type: "region" }).of(country.toUpperCase())?.toLowerCase() ?? country;
}

const tavilyAdapter: WebSearchAdapter = {
  id: "tavily",
  requiresKey: true,
  async search(query, ctx) {
    const payload: Record<string, unknown> = {
      query: query.query,
      search_depth: "basic",
      topic: query.topic,
      max_results: query.maxResults,
    };
    const timeRange = normalizeDateRange(query.date);
    if (timeRange) payload.time_range = timeRange;
    const country = query.topic === "general" ? normalizeTavilyCountry(query.country) : undefined;
    if (country) payload.country = country;
    if (query.images) payload.include_images = true;

    const response = await fetch(TAVILY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ctx.apiKey}` },
      body: JSON.stringify(payload),
      signal: ctx.signal,
    });

    if (!response.ok) throw new Error(`Web search failed (${response.status})${payload.country ? `; country=${payload.country} was retained. No broader search was submitted.` : ""}`);
    const data = (await response.json()) as { results?: Array<Record<string, unknown>>; images?: unknown[] };
    return { rows: (data.results ?? []).map(toRow), images: data.images ?? [] };
  },

  /**
   * `basic` depth to match the search above: it returns the page's body, and the
   * `advanced` tier buys tables and embedded content at several times the cost,
   * which is a choice for a deployment rather than for a sentence in a chat.
   *
   * A failure here returns nothing instead of throwing. The search already
   * succeeded, and snippets are the answer this tool gave for its whole life
   * before extraction existed — losing them to a second call that went wrong
   * would make asking for more actively worse than not asking.
   */
  async extract(urls, ctx) {
    if (!urls.length) return new Map();
    try {
      return (await tavilyExtract(urls, ctx)).pages;
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      return new Map();
    }
  },
  fetchPages: tavilyExtract,
};

async function tavilyExtract(urls: string[], ctx: WebSearchContext): Promise<FetchedPages> {
  const response = await fetch(TAVILY_EXTRACT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ctx.apiKey}` },
    body: JSON.stringify({ urls, extract_depth: "basic" }),
    signal: ctx.signal,
  });
  if (!response.ok) throw new Error(`Tavily extract failed: HTTP ${response.status}`);
  const data = (await response.json()) as {
    results?: Array<Record<string, unknown>>;
    failed_results?: Array<Record<string, unknown>>;
  };
  const pages = new Map<string, string>();
  for (const item of data.results ?? []) {
    const body = String(item.raw_content ?? "").trim();
    if (item.url && body) pages.set(String(item.url), body);
  }
  const failed = (data.failed_results ?? [])
    .filter((item) => item.url)
    .map((item) => ({ url: String(item.url), error: String(item.error ?? "no content returned") }));
  return { pages, failed };
}

const searxngAdapter: WebSearchAdapter = {
  id: "searxng",
  requiresKey: false,
  async search(query, ctx) {
    const root = ctx.baseUrl.replace(/\/+$/, "");
    if (!root) throw new Error("SearXNG is selected but no instance URL is configured");
    const categories = query.images ? "images" : query.topic === "news" ? "news" : "general";
    const url = new URL("search", `${root}/`);
    url.searchParams.set("q", query.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("categories", categories);
    url.searchParams.set("language", "all");
    if (query.country) url.searchParams.set("language", query.country);
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: ctx.signal,
    });
    if (!response.ok) throw new Error(`Web search failed (${response.status})`);
    const data = (await response.json()) as { results?: Array<Record<string, unknown>> };
    const rows = (data.results ?? []).slice(0, query.maxResults).map((item) => ({
      title: String(item.title ?? ""),
      url: String(item.url ?? item.img_src ?? ""),
      content: String(item.content ?? item.img_src ?? ""),
      published_date: item.publishedDate ? String(item.publishedDate) : undefined,
      source: hostname(String(item.url ?? item.img_src ?? "")),
    }));
    const images = query.images
      ? (data.results ?? []).map((item) => item.thumbnail_src ?? item.img_src ?? item.url).filter(Boolean)
      : [];
    return { rows, images };
  },
};

const ADAPTERS = new Map<string, WebSearchAdapter>(
  [tavilyAdapter, searxngAdapter].map((adapter) => [adapter.id, adapter]),
);

/** The adapter a deployment gets when its configuration names none, or names one that is gone. */
const DEFAULT_PROVIDER = "tavily";

/**
 * `pages` holds the body of whatever was read in full, keyed by url. It goes last
 * in a source's block so the metadata stays together above it, and it is not
 * truncated here: a character cap charges a Chinese page three times an English
 * one and cuts a table in half, and pi already bounds a tool result by lines and
 * bytes on a boundary it can name (`04-capabilities.md §9`).
 */
function formatWebResults(turn: number, rows: WebRow[], sourceType: "search" | "news", pages?: Map<string, string>) {
  if (!rows.length) return "";
  const title = sourceType === "search" ? `Web Results, Turn ${turn}` : "News Results";
  const formatted = rows.map((row, index) => {
    const lines = [
      `# ${sourceType.charAt(0).toUpperCase() + sourceType.slice(1)} ${index}: ${row.title ? `"${row.title}"` : "(no title)"}`,
      `\nAnchor: \\ue202turn${turn}${sourceType}${index}`,
      `URL: ${row.url}`,
    ];
    if (row.content != null) lines.push(`Summary: ${row.content}`);
    if (row.published_date != null) lines.push(`Date: ${row.published_date}`);
    if (row.source != null) lines.push(`Source: ${row.source}`);
    const body = pages?.get(row.url);
    if (body) lines.push(`Content:\n${body}`);
    return `${lines.join("\n")}\n`;
  });
  return `\n=== ${title} ===\n\n${formatted.join("\n")}`;
}

export function webSearchTool(options: {
  getApiKey: () => string | undefined;
  provider?: string;
  baseUrl?: string;
}): AgentTool {
  const provider = options.provider || DEFAULT_PROVIDER;
  return {
    name: "web_search",
    label: "web_search",
    description: WEB_SEARCH_DESCRIPTION,
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        intent: { type: "string", description: INTENT_DESCRIPTION },
        query: { type: "string", description: QUERY_DESCRIPTION },
        date: { type: "string", enum: ["h", "d", "w", "m", "y"], description: "Date range for search results." },
        country: { type: "string", description: COUNTRY_DESCRIPTION },
        images: { type: "boolean", description: "Whether to also run an image search." },
        news: { type: "boolean", description: "Whether to also run a news search." },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "How many results to read. Defaults to 5; raise it for a survey, lower it for a single fact.",
        },
        read_pages: { type: "integer", minimum: 0, maximum: 5, description: READ_PAGES_DESCRIPTION },
      },
      required: ["intent", "query"],
    }),
    execute: async (_callId, params, signal) => {
      const args = params as {
        query: string;
        date?: string;
        country?: string;
        images?: boolean;
        news?: boolean;
        max_results?: number;
        read_pages?: number;
      };
      const turn = nextCitationId();
      const adapter = ADAPTERS.get(provider);
      if (!adapter) throw new Error(`Unknown web search provider: ${provider}`);
      const apiKey = options.getApiKey();
      if (adapter.requiresKey && !apiKey) {
        throw new Error(`Web search is selected but the ${adapter.id} API key is not configured`);
      }

      const maxResults = Math.max(1, Math.min(20, Math.round(args.max_results ?? 5)));
      const ctx: WebSearchContext = { apiKey: apiKey ?? "", baseUrl: options.baseUrl ?? "", signal };
      const asked = { query: args.query, maxResults, date: args.date, country: args.country };

      // LibreChat always runs the general search, then adds independent
      // image/news searches when those booleans are requested. Its `videos`
      // flag is not offered here: no backend in the registry has a video
      // sub-search, and a parameter that returns nothing without saying so is
      // worse than absent.
      const tasks = [adapter.search({ ...asked, topic: "general", images: false }, ctx)];
      if (args.images === true) tasks.push(adapter.search({ ...asked, topic: "general", images: true }, ctx));
      if (args.news === true) tasks.push(adapter.search({ ...asked, topic: "news", images: false }, ctx));
      const [main, ...supplemental] = await Promise.all(tasks);
      const rows = main?.rows ?? [];
      const imageData = args.images === true ? supplemental.shift() : undefined;
      const newsData = args.news === true ? supplemental.shift() : undefined;
      const seenNews = new Set<string>();
      const newsRows = (newsData?.rows ?? [])
        .filter((row) => row.url && !seenNews.has(row.url) && seenNews.add(row.url))
        .slice(0, maxResults);

      // Snippets say which page is worth having; they do not carry what it says.
      // Only the general results are opened, and only the top few the model asked
      // for: a news snippet is a headline and a lede, and the story behind it is
      // the same page a general search returns when it is the better source.
      const wanted = Math.max(0, Math.min(5, Math.round(args.read_pages ?? 0)));
      const pages =
        wanted && adapter.extract
          ? await adapter.extract(
              rows
                .slice(0, wanted)
                .map((row) => row.url)
                .filter(Boolean),
              ctx,
            )
          : new Map<string, string>();

      const output = `${formatWebResults(turn, rows, "search", pages)}${formatWebResults(turn, newsRows, "news")}${imageData?.images?.length ? `\nImage candidates (URLs, not inspected pixels; acquire_resource before viewing/reusing):\n${JSON.stringify(imageData.images.slice(0, 6))}` : ""}`;
      const references = [
        ...rows.map((row) => ({ type: "search", link: row.url, title: row.title })),
        ...newsRows.map((row) => ({ type: "news", link: row.url, title: row.title })),
      ];
      return {
        content: [{ type: "text", text: output || `No results found for query: ${args.query}` }],
        details: {
          structuredContent: {
            web_search: {
              turn,
              organic: rows.map((row) => ({
                title: row.title,
                link: row.url,
                snippet: row.content,
                date: row.published_date,
              })),
              topStories: newsRows.map((row) => ({
                title: row.title,
                link: row.url,
                snippet: row.content,
                date: row.published_date,
                source: row.source,
              })),
              images: (imageData?.images ?? []).slice(0, 6),
              videos: [],
              references,
            },
          },
        },
      };
    },
  };
}

/** Enough for an article or a documentation page; past this the model asks for the section it needs. */
const FETCH_PAGE_CHARS = 40_000;

function parseUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads pages by address through the same backend as `web_search`. The
 * configured provider is the only one asked: if it cannot fetch pages the tool
 * says so, rather than quietly searching for the URL and returning snippets
 * as if they were the page.
 */
export function fetchUrlTool(options: {
  getApiKey: () => string | undefined;
  provider?: string;
  baseUrl?: string;
}): AgentTool {
  const provider = options.provider || DEFAULT_PROVIDER;
  return {
    name: "fetch_url",
    label: "fetch_url",
    description: FETCH_URL_DESCRIPTION,
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 5,
          description: "Absolute http(s) URLs to read, in the order they should be reported.",
        },
      },
      required: ["urls"],
    }),
    execute: async (_callId, params, signal) => {
      const args = params as { urls?: unknown };
      const requested = Array.isArray(args.urls) ? args.urls.filter((item): item is string => typeof item === "string") : [];
      if (!requested.length) throw new Error("urls must list at least one http(s) URL");
      const invalid = requested.filter((item) => !parseUrl(item));
      if (invalid.length) throw new Error(`Not http(s) URLs: ${invalid.join(", ")}`);
      const urls = [...new Set(requested.slice(0, 5).map((item) => parseUrl(item)!))];

      const adapter = ADAPTERS.get(provider);
      if (!adapter) throw new Error(`Unknown web search provider: ${provider}`);
      if (!adapter.fetchPages) {
        throw new Error(`The configured web provider (${adapter.id}) cannot read pages by URL. No page was fetched; switch the web search provider to one with page extraction (Tavily) or ask the user for the text.`);
      }
      const apiKey = options.getApiKey();
      if (adapter.requiresKey && !apiKey) throw new Error(`Reading pages is selected but the ${adapter.id} API key is not configured`);

      const turn = nextCitationId();
      const ctx: WebSearchContext = { apiKey: apiKey ?? "", baseUrl: options.baseUrl ?? "", signal };
      const { pages, failed } = await adapter.fetchPages(urls, ctx);
      const failures = new Map(failed.map((item) => [item.url, item.error]));

      // The provider may echo a normalized URL (a dropped or added trailing
      // slash); text and structured fields must agree on what was read, so
      // both go through the same lookups.
      const pageFor = (url: string) => pages.get(url) ?? pages.get(url.replace(/\/$/, "")) ?? pages.get(`${url}/`);
      const failureFor = (url: string) => failures.get(url) ?? failures.get(url.replace(/\/$/, "")) ?? failures.get(`${url}/`);

      const sections = urls.map((url, index) => {
        const body = pageFor(url);
        const lines = [`# Ref ${index}: ${url}`, `\nAnchor: \ue202turn${turn}ref${index}`, `URL: ${url}`];
        if (body) {
          const truncated = body.length > FETCH_PAGE_CHARS;
          lines.push(`Content${truncated ? ` (first ${FETCH_PAGE_CHARS} of ${body.length} characters)` : ""}:\n${body.slice(0, FETCH_PAGE_CHARS)}`);
        } else {
          lines.push(`Not read: ${failureFor(url) ?? "the page returned no readable text"}`);
        }
        return `${lines.join("\n")}\n`;
      });

      return {
        content: [{ type: "text", text: `\n=== Pages, Turn ${turn} ===\n\n${sections.join("\n")}` }],
        details: {
          structuredContent: {
            fetch_url: {
              turn,
              pages: urls.map((url) => ({ link: url, read: pageFor(url) !== undefined, error: failureFor(url) })),
              references: urls.filter((url) => pageFor(url) !== undefined).map((url) => ({ type: "ref", link: url, title: url })),
            },
          },
        },
      };
    },
  };
}
