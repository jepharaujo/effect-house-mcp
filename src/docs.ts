import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { extractDoc } from './html.js';

/**
 * Reads the official documentation at effecthouse.tiktok.com/learn. The page
 * list comes from the site's sitemap; pages are fetched on demand and cached,
 * and cached pages make the search full-text.
 */

export const DOCS_ORIGIN = 'https://effecthouse.tiktok.com';
export const DOCS_PREFIX = '/learn/';
const SITEMAP_URL = `${DOCS_ORIGIN}/learn/sitemap.xml`;
const SITEMAP_TTL_MS = 24 * 60 * 60 * 1000;
const PAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Accepts a full URL or a path such as `guides/api-reference/scene/transform`. */
export function normalizeDocsUrl(input: string): string {
  const trimmed = input.trim();
  let url: URL;
  if (/^https?:\/\//i.test(trimmed)) {
    url = new URL(trimmed);
  } else {
    let relative = trimmed.replace(/^\/+/, '');
    if (!relative.startsWith('learn/')) relative = `learn/${relative}`;
    url = new URL(`/${relative}`, DOCS_ORIGIN);
  }
  if (url.hostname !== new URL(DOCS_ORIGIN).hostname) {
    throw new Error(`Only ${DOCS_ORIGIN}${DOCS_PREFIX} pages can be read (got ${url.hostname}).`);
  }
  if (!url.pathname.startsWith(DOCS_PREFIX) && url.pathname !== '/learn') {
    throw new Error(`Only pages under ${DOCS_PREFIX} can be read (got ${url.pathname}).`);
  }
  url.protocol = 'https:';
  url.hash = '';
  url.search = '';
  return url.toString();
}

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'of',
  'in',
  'and',
  'or',
  'for',
  'how',
  'with',
  'on',
  'is',
  'what',
  'use',
  'using',
  'my',
  'i',
  'do',
  'de',
  'da',
  'das',
  'dos',
  'como',
  'para',
  'com',
  'em',
  'o',
  'os',
  'as',
  'um',
  'uma',
  'no',
  'na',
  'e',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function guidePath(url: string): string[] {
  const pathname = new URL(url).pathname.replace(/^\/learn\//, '').replace(/\/$/, '');
  const parts = pathname.split('/').filter(Boolean);
  return parts[0] === 'guides' ? parts.slice(1) : parts;
}

export function humanize(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) =>
      word.length <= 3 && /^(ai|ar|ui|vfx|2d|3d|api|apjs|pbr|gpu|sdk)$/i.test(word)
        ? word.toUpperCase()
        : word[0]?.toUpperCase() + word.slice(1),
    )
    .join(' ');
}

export interface SearchHit {
  url: string;
  title: string;
  section: string;
  score: number;
  snippet?: string;
}

interface CachedPage {
  url: string;
  title: string;
  markdown: string;
  fetchedAt: string;
}

interface IndexedPage {
  title: string;
  titleTokens: Set<string>;
  textLower: string;
  markdown: string;
}

export function scoreUrl(url: string, queryTokens: string[], page?: IndexedPage): number {
  const segments = guidePath(url);
  const last = tokenize(segments.at(-1) ?? '');
  const rest = tokenize(segments.slice(0, -1).join(' '));
  let score = 0;
  let matched = 0;
  for (const token of queryTokens) {
    let tokenScore = 0;
    if (last.includes(token)) tokenScore += 4;
    else if (token.length >= 3 && last.some((word) => word.startsWith(token))) tokenScore += 2;
    if (rest.includes(token)) tokenScore += 1.5;
    else if (token.length >= 3 && rest.some((word) => word.startsWith(token))) tokenScore += 0.75;
    if (page) {
      if (page.titleTokens.has(token)) tokenScore += 3;
      const occurrences = page.textLower.split(token).length - 1;
      tokenScore += Math.min(occurrences, 5) * 0.4;
    }
    if (tokenScore > 0) matched++;
    score += tokenScore;
  }
  if (queryTokens.length > 1 && segments.join('/').includes(queryTokens.join('-'))) score += 3;
  if (queryTokens.length > 1 && matched === queryTokens.length) score *= 1.5;
  return score;
}

function snippetFor(page: IndexedPage, tokens: string[]): string | undefined {
  for (const token of tokens) {
    const at = page.textLower.indexOf(token);
    if (at < 0) continue;
    const from = Math.max(0, at - 120);
    const text = page.markdown
      .slice(from, at + 160)
      .replace(/\s+/g, ' ')
      .trim();
    return `${from > 0 ? '…' : ''}${text}…`;
  }
  return undefined;
}

export interface DocsStoreOptions {
  cacheDir: string;
  userAgent: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class DocsStore {
  private urls?: string[];
  private index?: Map<string, IndexedPage>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: DocsStoreOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private get pagesDir(): string {
    return path.join(this.options.cacheDir, 'pages');
  }

  private pageFile(url: string): string {
    return path.join(this.pagesDir, `${createHash('sha1').update(url).digest('hex')}.json`);
  }

  private async fetchText(url: string, accept: string): Promise<string> {
    const response = await this.fetchImpl(url, {
      headers: { 'user-agent': this.options.userAgent, accept },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
    if (response.url && new URL(response.url).hostname !== new URL(DOCS_ORIGIN).hostname) {
      throw new Error(`${url} redirected off the docs site (${response.url})`);
    }
    return response.text();
  }

  /** All documentation page URLs, from the sitemap (cached for a day). */
  async sitemap(): Promise<string[]> {
    if (this.urls) return this.urls;
    const file = path.join(this.options.cacheDir, 'sitemap.json');
    let cached: { fetchedAt: string; urls: string[] } | undefined;
    try {
      cached = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      cached = undefined;
    }
    if (cached && this.now() - Date.parse(cached.fetchedAt) < SITEMAP_TTL_MS) {
      this.urls = cached.urls;
      return this.urls;
    }
    try {
      const xml = await this.fetchText(SITEMAP_URL, 'application/xml');
      const urls = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)]
        .map((match) => match[1]?.replace(/&amp;/g, '&') ?? '')
        .filter((url) => url.startsWith(`${DOCS_ORIGIN}${DOCS_PREFIX}`));
      if (urls.length === 0) throw new Error('the sitemap listed no pages');
      this.urls = [...new Set(urls)];
      await mkdir(this.options.cacheDir, { recursive: true });
      await writeFile(file, JSON.stringify({ fetchedAt: new Date(this.now()).toISOString(), urls: this.urls }));
      return this.urls;
    } catch (error) {
      if (cached) {
        this.urls = cached.urls; // Stale beats nothing when offline.
        return this.urls;
      }
      throw error;
    }
  }

  async read(input: string, options: { refresh?: boolean } = {}): Promise<CachedPage> {
    const url = normalizeDocsUrl(input);
    const file = this.pageFile(url);
    if (!options.refresh) {
      try {
        const cached = JSON.parse(await readFile(file, 'utf8')) as CachedPage;
        if (this.now() - Date.parse(cached.fetchedAt) < PAGE_TTL_MS) return cached;
      } catch {
        // Not cached yet.
      }
    }
    const html = await this.fetchText(url, 'text/html');
    const { title, markdown } = extractDoc(html, url);
    const page: CachedPage = {
      url,
      title: title || humanize(guidePath(url).at(-1) ?? ''),
      markdown,
      fetchedAt: new Date(this.now()).toISOString(),
    };
    await mkdir(this.pagesDir, { recursive: true });
    await writeFile(file, JSON.stringify(page));
    this.index?.set(url, indexPage(page));
    return page;
  }

  private async loadIndex(): Promise<Map<string, IndexedPage>> {
    if (this.index) return this.index;
    const index = new Map<string, IndexedPage>();
    let files: string[] = [];
    try {
      files = await readdir(this.pagesDir);
    } catch {
      // No cached pages yet.
    }
    await Promise.all(
      files
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          try {
            const page = JSON.parse(await readFile(path.join(this.pagesDir, name), 'utf8')) as CachedPage;
            index.set(page.url, indexPage(page));
          } catch {
            // Ignore a damaged cache entry.
          }
        }),
    );
    this.index = index;
    return index;
  }

  async search(
    query: string,
    options: { limit?: number; section?: string } = {},
  ): Promise<{ hits: SearchHit[]; indexedPages: number; totalPages: number }> {
    const tokens = [...new Set(tokenize(query))];
    const [urls, index] = await Promise.all([this.sitemap(), this.loadIndex()]);
    const section = options.section?.toLowerCase().replace(/^\/+|\/+$/g, '');
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 30);
    const hits: SearchHit[] = [];
    if (tokens.length > 0) {
      for (const url of urls) {
        const segments = guidePath(url);
        if (section && !segments.join('/').startsWith(section)) continue;
        const page = index.get(url);
        const score = scoreUrl(url, tokens, page);
        if (score <= 0) continue;
        hits.push({
          url,
          title: page?.title ?? humanize(segments.at(-1) ?? 'Learn'),
          section: segments.slice(0, -1).join(' / '),
          score: Math.round(score * 100) / 100,
          snippet: page ? snippetFor(page, tokens) : undefined,
        });
      }
    }
    hits.sort((a, b) => b.score - a.score || a.url.length - b.url.length);
    return { hits: hits.slice(0, limit), indexedPages: index.size, totalPages: urls.length };
  }

  /** Fetches every sitemap page that is not cached yet, a few at a time. */
  async indexAll(
    onProgress: (done: number, total: number, url: string, error?: string) => void,
    concurrency = 4,
  ): Promise<{ fetched: number; failed: number }> {
    const urls = await this.sitemap();
    const index = await this.loadIndex();
    const pending = urls.filter((url) => !index.has(url));
    let next = 0;
    let done = 0;
    let failed = 0;
    const worker = async () => {
      while (next < pending.length) {
        const url = pending[next++] as string;
        try {
          await this.read(url);
          onProgress(++done, pending.length, url);
        } catch (error) {
          failed++;
          onProgress(++done, pending.length, url, (error as Error).message);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    return { fetched: done - failed, failed };
  }
}

function indexPage(page: CachedPage): IndexedPage {
  return {
    title: page.title,
    titleTokens: new Set(tokenize(page.title)),
    textLower: page.markdown.toLowerCase(),
    markdown: page.markdown,
  };
}
