// Thin client for QUL's public JSON API (https://qul.tarteel.ai/api/v1).
//
// The API is not formally documented yet (the docs call it "coming soon"), so
// this client only relies on endpoints that answer without authentication and
// is written defensively around a few quirks noted below.

export const DEFAULT_BASE_URL = "https://qul.tarteel.ai/api/v1";
const MAX_PER_PAGE = 286;
const TIMEOUT_MS = 30_000;

export class QulError extends Error {}

export interface Pagination {
  next_page: number | null;
  previous_page: number | null;
  total_pages: number;
  total_count: number;
}

type Params = Record<string, string | number | boolean | undefined | null>;

export class QulClient {
  constructor(
    private readonly baseUrl: string = process.env.QUL_API_BASE_URL || DEFAULT_BASE_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get<T = any>(path: string, params: Params = {}): Promise<T> {
    const url = new URL(this.baseUrl.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, ""));
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": "qul-mcp" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new QulError(`Could not reach QUL at ${url.origin}: ${(err as Error).message}`);
    }

    const body = await res.text();
    let data: any;
    try {
      data = JSON.parse(body);
    } catch {
      throw new QulError(`QUL returned a non-JSON response (HTTP ${res.status}) for ${url.pathname}`);
    }

    if (!res.ok) {
      const message = data?.message || data?.error || `HTTP ${res.status}`;
      throw new QulError(`QUL ${res.status}: ${message}`);
    }
    return data as T;
  }

  /**
   * Fetches every page of a paginated endpoint until `limit` items are
   * collected or the server runs out of pages.
   */
  async getAllPages<T>(
    path: string,
    params: Params,
    pick: (page: any) => T[],
    limit: number,
  ): Promise<{ items: T[]; total: number; firstPage: any }> {
    const perPage = stablePerPage(Math.min(limit, MAX_PER_PAGE));
    const items: T[] = [];
    let page = 1;
    let total = 0;
    let firstPage: any;

    while (items.length < limit) {
      const data = await this.get(path, { ...params, per_page: perPage, page });
      firstPage ??= data;
      items.push(...pick(data));
      const pagination: Pagination | undefined = data.pagination;
      total = pagination?.total_count ?? items.length;
      if (!pagination?.next_page) break;
      page = pagination.next_page;
    }

    return { items: items.slice(0, limit), total, firstPage };
  }
}

/**
 * QUL computes the page size as `[per_page | 10, 286].min` (a bitwise OR, so
 * per_page=5 yields 15 and per_page=50 yields 58). Return the smallest value
 * >= n that survives that OR unchanged, so page boundaries stay predictable.
 */
export function stablePerPage(n: number): number {
  let v = Math.max(10, Math.ceil(n));
  while ((v | 10) !== v) v++;
  return Math.min(v, MAX_PER_PAGE);
}

const AYAH_KEY = /^(\d{1,3}):(\d{1,3})$/;

export function parseAyahKey(key: string): { chapter: number; verse: number } {
  const m = AYAH_KEY.exec(key.trim());
  if (!m) throw new QulError(`"${key}" is not an ayah key. Use "chapter:verse", e.g. "2:255".`);
  const chapter = Number(m[1]);
  const verse = Number(m[2]);
  if (chapter < 1 || chapter > 114) throw new QulError(`Chapter ${chapter} is out of range (1-114).`);
  if (verse < 1) throw new QulError(`Verse number must be 1 or more, got ${verse}.`);
  return { chapter, verse };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Turns QUL's HTML (tafsir bodies, translation footnote markers) into plain
 * text that is cheaper for a model to read.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<sup\b[^>]*foot_note[^>]*>.*?<\/sup>/gis, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Splits text into chunks of at most `size` characters without losing any of
 * it. Breaks at paragraph boundaries where possible, then at line breaks or
 * sentence ends, and only splits mid-sentence for a single enormous sentence.
 */
export function splitText(text: string, size: number, html = false): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    let cut = -1;
    if (html) {
      // Only break between elements so no tag is cut in half.
      for (const m of window.matchAll(/<\/(?:p|div|h[1-6]|li|blockquote|table)>|<br\s*\/?>/gi)) {
        cut = m.index + m[0].length;
      }
      if (cut <= 0) cut = window.lastIndexOf(">") + 1;
      if (cut <= 0) cut = size;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
      continue;
    }
    cut = window.lastIndexOf("\n\n");
    if (cut < size / 2) cut = Math.max(window.lastIndexOf("\n"), cut);
    if (cut < size / 2) {
      for (const m of window.matchAll(/[.!?؟۔]\s/g)) cut = Math.max(cut, m.index + 1);
    }
    if (cut < size / 2) cut = Math.max(window.lastIndexOf(" "), cut);
    if (cut <= 0) cut = size;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export interface Piece<T> {
  item: T;
  text: string;
  /** Present when one entry was split: 1-based index and count. */
  segment?: { index: number; of: number };
}

/**
 * Packs entries into parts of at most `budget` characters, splitting any
 * entry that is larger than a whole part. Every character of every entry
 * appears in exactly one part, in order.
 */
export function packParts<T>(entries: { item: T; text: string }[], budget: number, html = false): Piece<T>[][] {
  const parts: Piece<T>[][] = [];
  let current: Piece<T>[] = [];
  let used = 0;

  const flush = () => {
    if (current.length) parts.push(current);
    current = [];
    used = 0;
  };

  for (const { item, text } of entries) {
    const chunks = splitText(text, budget, html);
    chunks.forEach((chunk, i) => {
      if (used > 0 && used + chunk.length > budget) flush();
      current.push({ item, text: chunk, ...(chunks.length > 1 ? { segment: { index: i + 1, of: chunks.length } } : {}) });
      used += chunk.length;
    });
  }
  flush();
  return parts;
}
