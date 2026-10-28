import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeEntities, extractDoc, htmlToMarkdown } from '../src/html.js';

const BASE = 'https://effecthouse.tiktok.com/learn/guides/example/page';

describe('decodeEntities', () => {
  it('decodes named and numeric entities', () => {
    assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#39;d&#x27; &rarr; &unknown;'), "a & b <c> 'd' → &unknown;");
  });
});

describe('htmlToMarkdown', () => {
  it('converts headings, paragraphs, emphasis and drops permalinks', () => {
    const html =
      '<h2 class="anchor" id="x">How It Works<a href="#x" class="hash-link" aria-label="Direct link">​</a></h2>' +
      '<p>Use <strong>Face Mask</strong> with <em>care</em> and <code>APJS</code>.</p>';
    assert.equal(htmlToMarkdown(html, BASE), '## How It Works\n\nUse **Face Mask** with *care* and `APJS`.');
  });

  it('keeps code blocks verbatim, one line per token line', () => {
    const html =
      '<pre class="prism-code language-ts"><code><span class="token-line"><span>let a = 1 &lt; 2;</span><br></span>' +
      '<span class="token-line"><span>  return a;</span><br></span></code></pre>';
    assert.equal(htmlToMarkdown(html, BASE), '```ts\nlet a = 1 < 2;\n  return a;\n```');
  });

  it('omits the language label "text"', () => {
    const html = '<pre class="prism-code language-text"><code>x</code></pre>';
    assert.equal(htmlToMarkdown(html, BASE), '```\nx\n```');
  });

  it('renders tables with a header row and escapes pipes', () => {
    const html =
      '<table><thead><tr><th>Type</th><th>Name</th></tr></thead>' +
      '<tbody><tr><td>Variables</td><td><p>a | b</p></td></tr></tbody></table>';
    assert.equal(htmlToMarkdown(html, BASE), '| Type | Name |\n| --- | --- |\n| Variables | a \\| b |');
  });

  it('renders nested and ordered lists', () => {
    const html = '<ol><li>One</li><li>Two<ul><li><p>Inner</p></li></ul></li></ol>';
    assert.equal(htmlToMarkdown(html, BASE), '1. One\n2. Two\n  - Inner');
  });

  it('makes links and images absolute and drops in-page anchors', () => {
    const html =
      '<p><a href="../other">Other page</a>, <a href="#top">top</a>, ' + '<img src="/img/a.png" alt="Panel [x]"></p>';
    assert.equal(
      htmlToMarkdown(html, BASE),
      '[Other page](https://effecthouse.tiktok.com/learn/guides/other), top, ![Panel x](https://effecthouse.tiktok.com/img/a.png)',
    );
  });

  it('drops scripts, styles, svg and buttons', () => {
    const html = '<script>alert(1)</script><style>p{}</style><p>Kept<svg><path d="M0"/></svg><button>Copy</button></p>';
    assert.equal(htmlToMarkdown(html, BASE), 'Kept');
  });
});

describe('extractDoc', () => {
  it('takes the markdown body of the article and its h1 title', () => {
    const html =
      '<html><head><title>Face Mask | Learn | TikTok Effect House</title></head><body>' +
      '<nav>Menu</nav><article><nav class="breadcrumbs">Crumbs</nav>' +
      '<div class="theme-doc-markdown markdown"><h1>Face Mask</h1><p>Body text.</p></div></article>' +
      '<footer>Footer</footer></body></html>';
    const doc = extractDoc(html, BASE);
    assert.equal(doc.title, 'Face Mask');
    assert.equal(doc.markdown, '# Face Mask\n\nBody text.');
  });

  it('falls back to the page title without the site suffix', () => {
    const doc = extractDoc('<title>Glossary | Learn | TikTok Effect House</title><main><p>x</p></main>', BASE);
    assert.equal(doc.title, 'Glossary');
  });
});
