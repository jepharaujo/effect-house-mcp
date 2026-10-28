/**
 * Converts Effect House documentation pages (Docusaurus 2) into Markdown that
 * an agent can read. It targets that site's markup, not arbitrary HTML.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  bull: '•',
  middot: '·',
  deg: '°',
  plusmn: '±',
  le: '≤',
  ge: '≥',
  ne: '≠',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  if (!match) return undefined;
  return decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
}

function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** Removes whole elements whose content is never documentation text. */
function dropElements(html: string): string {
  let result = html;
  for (const tag of ['script', 'style', 'noscript', 'svg', 'button', 'nav', 'footer', 'template']) {
    result = result.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'gi'), '');
  }
  // Heading permalinks ("#") added by Docusaurus.
  return result.replace(/<a\b[^>]*class="[^"]*hash-link[^"]*"[^>]*>[\s\S]*?<\/a>/gi, '');
}

interface ListFrame {
  ordered: boolean;
  index: number;
}

export function htmlToMarkdown(html: string, baseUrl: string): string {
  const codeBlocks: string[] = [];
  const withoutCode = dropElements(html).replace(
    /<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi,
    (_match, attrs: string, inner: string) => {
      const language = /language-([\w+-]+)/.exec(attrs)?.[1];
      const code = decodeEntities(stripTags(inner.replace(/<br\s*\/?>/gi, '\n'))).replace(/\s+$/, '');
      const fence = code.includes('```') ? '````' : '```';
      codeBlocks.push(`${fence}${language && language !== 'text' ? language : ''}\n${code}\n${fence}`);
      return `\uE000${codeBlocks.length - 1}\uE001`;
    },
  );

  const out: string[] = [];
  const lists: ListFrame[] = [];
  const links: (string | null)[] = [];
  const divs: string[] = [];
  let table: { rows: string[][]; header: boolean } | undefined;
  let row: string[] | undefined;
  let cell: string[] | undefined;
  let freshItem = false;

  const emit = (text: string) => {
    if (cell) cell.push(text);
    else out.push(text);
  };
  const block = (text: string) => emit(cell ? ' ' : text);

  const tokens = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
  for (const match of withoutCode.matchAll(tokens)) {
    const [whole, closing, rawTag, attrs = ''] = match;
    if (whole.startsWith('<!--')) continue;
    if (!rawTag) {
      const text = decodeEntities(whole).replace(/​/g, '').replace(/\s+/g, ' ');
      if (text.trim()) freshItem = false;
      emit(text);
      continue;
    }
    const tag = rawTag.toLowerCase();
    const isClose = closing === '/';

    switch (tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        block(isClose ? '\n\n' : `\n\n${'#'.repeat(Number(tag[1]))} `);
        break;
      case 'p':
        if (lists.length > 0) {
          if (!isClose && !freshItem) emit(`\n${'  '.repeat(lists.length)}`);
        } else {
          block('\n\n');
        }
        break;
      case 'br':
        block('\n');
        break;
      case 'hr':
        block('\n\n---\n\n');
        break;
      case 'ul':
      case 'ol':
        // Only the outermost list is set apart; nested items start on their own `li` line.
        if (isClose) {
          lists.pop();
          if (lists.length === 0) block('\n\n');
        } else {
          if (lists.length === 0) block('\n\n');
          lists.push({ ordered: tag === 'ol', index: 0 });
        }
        break;
      case 'li': {
        if (isClose) break;
        const frame = lists.at(-1);
        const marker = frame?.ordered ? `${++frame.index}.` : '-';
        emit(`\n${'  '.repeat(Math.max(0, lists.length - 1))}${marker} `);
        freshItem = true;
        break;
      }
      case 'strong':
      case 'b':
        emit('**');
        break;
      case 'em':
      case 'i':
        emit('*');
        break;
      case 'code':
        emit('`');
        break;
      case 'a':
        if (isClose) {
          const href = links.pop();
          if (href) emit(`](${href})`);
        } else {
          const href = attribute(attrs, 'href');
          const target =
            href && !href.startsWith('#') && !href.startsWith('javascript:') ? absolute(href, baseUrl) : null;
          links.push(target);
          if (target) emit('[');
        }
        break;
      case 'img': {
        const src = attribute(attrs, 'src');
        if (src) emit(`![${(attribute(attrs, 'alt') ?? '').replace(/[[\]]/g, '')}](${absolute(src, baseUrl)})`);
        break;
      }
      case 'div': {
        if (isClose) {
          if (divs.pop() === 'admonition-heading') emit(':**\n');
          break;
        }
        const className = attribute(attrs, 'class') ?? '';
        const kind = /admonitionHeading/.test(className) ? 'admonition-heading' : 'div';
        divs.push(kind);
        if (kind === 'admonition-heading') block('\n\n**');
        break;
      }
      case 'summary':
        block(isClose ? '**\n\n' : '\n\n**');
        break;
      case 'blockquote':
        block(isClose ? '\n\n' : '\n\n> ');
        break;
      case 'table':
        if (isClose) {
          if (table) out.push(renderTable(table.rows, table.header));
          table = undefined;
        } else {
          table = { rows: [], header: false };
        }
        break;
      case 'tr':
        if (!table) break;
        if (isClose) {
          if (row) table.rows.push(row);
          row = undefined;
        } else {
          row = [];
        }
        break;
      case 'th':
      case 'td':
        if (!row) break;
        if (isClose) {
          if (cell) row.push(cell.join(''));
          cell = undefined;
        } else {
          if (tag === 'th' && table && table.rows.length === 0) table.header = true;
          cell = [];
        }
        break;
      default:
        break;
    }
  }

  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+\n/g, '\n\n')
    .replace(/([^\s]) {2,}/g, '$1 ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\uE000(\d+)\uE001/g, (_match, index: string) => `\n\n${codeBlocks[Number(index)]}\n\n`)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderTable(rows: string[][], hasHeader: boolean): string {
  if (rows.length === 0) return '';
  const clean = rows.map((cells) => cells.map((value) => value.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')));
  const width = Math.max(...clean.map((cells) => cells.length));
  const pad = (cells: string[]) => [...cells, ...Array(width - cells.length).fill('')];
  const [first, ...rest] = hasHeader ? clean : [Array(width).fill(''), ...clean];
  const line = (cells: string[]) => `| ${pad(cells).join(' | ')} |`;
  return `\n\n${[line(first ?? []), line(Array(width).fill('---')), ...rest.map(line)].join('\n')}\n\n`;
}

export interface ExtractedDoc {
  title: string;
  markdown: string;
}

/** Picks the article body of a docs page and converts it. */
export function extractDoc(html: string, pageUrl: string): ExtractedDoc {
  let start = html.search(/<div[^>]*class="[^"]*theme-doc-markdown/i);
  if (start < 0) start = html.search(/<article\b/i);
  if (start < 0) start = html.search(/<main\b/i);
  let end = start >= 0 ? html.indexOf('</article>', start) : -1;
  if (end < 0 && start >= 0) end = html.indexOf('</main>', start);
  const body = start >= 0 ? html.slice(start, end > start ? end : undefined) : html;

  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1];
  const pageTitle = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = decodeEntities(stripTags(heading ?? pageTitle ?? ''))
    .replace(/\s*\|\s*Learn\s*\|\s*TikTok Effect House\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { title, markdown: htmlToMarkdown(body, pageUrl) };
}
