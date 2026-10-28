import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { DocsStore, humanize, normalizeDocsUrl, scoreUrl, tokenize } from '../src/docs.js';

const ORIGIN = 'https://effecthouse.tiktok.com';
const URLS = [
  `${ORIGIN}/learn/guides/workspace/objects/face-effects/face-mask`,
  `${ORIGIN}/learn/guides/workspace/objects/face-effects/face-stretch`,
  `${ORIGIN}/learn/guides/api-reference/animation/tweenanimation`,
  `${ORIGIN}/learn/guides/editor-panels/visual-scripting/nodes/time/wait-for-seconds`,
  `${ORIGIN}/learn/guides/getting-started/introduction-to-effect-house/glossary`,
];

function fakeFetch(pages: Record<string, string>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = pages[url];
    if (body === undefined) return new Response('missing', { status: 404 });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

const sitemap = `<?xml version="1.0"?><urlset>${URLS.map((url) => `<url><loc>${url}</loc></url>`).join('')}<url><loc>https://other.example/learn/x</loc></url></urlset>`;

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'eh-docs-'));
  dirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('normalizeDocsUrl', () => {
  it('accepts full URLs and paths, dropping hash and query', () => {
    assert.equal(normalizeDocsUrl(`${ORIGIN}/learn/guides/a?x=1#b`), `${ORIGIN}/learn/guides/a`);
    assert.equal(normalizeDocsUrl('guides/a'), `${ORIGIN}/learn/guides/a`);
    assert.equal(normalizeDocsUrl('/learn/guides/a'), `${ORIGIN}/learn/guides/a`);
    assert.equal(normalizeDocsUrl('http://effecthouse.tiktok.com/learn/guides/a'), `${ORIGIN}/learn/guides/a`);
  });

  it('refuses other hosts and paths outside /learn/', () => {
    assert.throws(() => normalizeDocsUrl('https://example.com/learn/a'), /Only/);
    assert.throws(() => normalizeDocsUrl(`${ORIGIN}/api/secret`), /Only pages under/);
  });
});

describe('search ranking', () => {
  it('tokenizes and drops stopwords', () => {
    assert.deepEqual(tokenize('How to use the Face-Mask in 3D'), ['face', 'mask', '3d']);
  });

  it('ranks the page whose slug matches every word first', () => {
    const tokens = tokenize('face mask');
    const scores = URLS.map((url) => scoreUrl(url, tokens));
    assert.ok((scores[0] ?? 0) > (scores[1] ?? 0));
    assert.equal(scores[2], 0);
  });

  it('humanizes slugs', () => {
    assert.equal(humanize('effect-house-ai-overview'), 'Effect House AI Overview');
  });
});

describe('DocsStore', () => {
  it('lists sitemap pages, reads a page and makes it full-text searchable', async () => {
    const calls: string[] = [];
    const page = `<title>Wait For Seconds | Learn | TikTok Effect House</title><article><div class="theme-doc-markdown markdown"><h1>Wait For Seconds</h1><p>Delays the flow by a duration in seconds.</p></div></article>`;
    const store = new DocsStore({
      cacheDir: await tempDir(),
      userAgent: 'test',
      fetchImpl: fakeFetch({ [`${ORIGIN}/learn/sitemap.xml`]: sitemap, [URLS[3] as string]: page }, calls),
    });

    assert.deepEqual(await store.sitemap(), URLS);
    const before = await store.search('delays duration');
    assert.equal(before.hits.length, 0);

    const read = await store.read('guides/editor-panels/visual-scripting/nodes/time/wait-for-seconds');
    assert.equal(read.title, 'Wait For Seconds');
    assert.match(read.markdown, /Delays the flow/);

    const afterRead = await store.search('delays duration');
    assert.equal(afterRead.hits[0]?.url, URLS[3]);
    assert.equal(afterRead.indexedPages, 1);
    assert.match(afterRead.hits[0]?.snippet ?? '', /Delays the flow/);

    await store.read(URLS[3] as string);
    assert.equal(calls.filter((url) => url === URLS[3]).length, 1, 'second read is served from the cache');
  });

  it('filters by section', async () => {
    const store = new DocsStore({
      cacheDir: await tempDir(),
      userAgent: 'test',
      fetchImpl: fakeFetch({ [`${ORIGIN}/learn/sitemap.xml`]: sitemap }),
    });
    const { hits } = await store.search('face', { section: 'api-reference' });
    assert.equal(hits.length, 0);
    const { hits: workspaceHits } = await store.search('face', { section: 'workspace/objects' });
    assert.equal(workspaceHits.length, 2);
  });

  it('reuses a stale sitemap when the site cannot be reached', async () => {
    const cacheDir = await tempDir();
    let now = Date.parse('2026-01-01T00:00:00Z');
    const online = new DocsStore({
      cacheDir,
      userAgent: 'test',
      now: () => now,
      fetchImpl: fakeFetch({ [`${ORIGIN}/learn/sitemap.xml`]: sitemap }),
    });
    await online.sitemap();
    now += 3 * 24 * 60 * 60 * 1000;
    const offline = new DocsStore({ cacheDir, userAgent: 'test', now: () => now, fetchImpl: fakeFetch({}) });
    assert.deepEqual(await offline.sitemap(), URLS);
  });
});
