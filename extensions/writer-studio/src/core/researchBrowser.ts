// Research beside the draft: open a page in VS Code's Simple Browser, or
// capture it as a readable Markdown source under <workspace>/sources/, where
// the readings index, quote checks and AI agents can read and cite it.

import * as fs from 'fs';
import * as path from 'path';
import type * as vscodeTypes from 'vscode';
import { slugify } from './pdfStore';

export const SOURCES_DIR = 'sources';
const FETCH_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 60 * 1024 * 1024;
// Below this much text a <main>/<article> region is probably a teaser, not the page.
const MIN_REGION_CHARS = 300;
const USER_AGENT = 'Mozilla/5.0 (compatible; VSwriter/0.3; research capture)';

// ---------------------------------------------------------------------------
// URLs

export function isHttpUrl(value: unknown): value is string {
	if (typeof value !== 'string') {
		return false;
	}
	try {
		const u = new URL(value.trim());
		return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
	} catch {
		return false;
	}
}

// "example.org/page" gets https:// in front. Anything else is returned trimmed.
export function normalizeUrlInput(value: string): string {
	const v = value.trim();
	if (/^[a-z][a-z0-9+.-]*:/i.test(v)) {
		return v;
	}
	return /^[\w-]+(\.[\w-]+)+(?::\d+)?(?:[/?#]|$)/.test(v) ? `https://${v}` : v;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]]+/i;

// First http(s) URL among the candidates: a command argument, the selected
// text (a bare URL or one inside a sentence), the clipboard.
export function defaultUrl(candidates: Array<string | undefined>): string {
	for (const c of candidates) {
		if (!c) {
			continue;
		}
		// Sentence punctuation after a pasted URL is not part of it.
		const found = (isHttpUrl(c) ? c.trim() : URL_IN_TEXT.exec(c)?.[0])?.replace(/[.,;:!?]+$/, '');
		if (found && isHttpUrl(found)) {
			return found;
		}
	}
	return '';
}

// ---------------------------------------------------------------------------
// HTML to Markdown

const NAMED: Record<string, string> = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
	shy: '', zwnj: '', zwj: '', lrm: '', rlm: '', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', sbquo: '‚',
	ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', bull: '•', middot: '·', copy: '©',
	reg: '®', trade: '™', deg: '°', sect: '§', para: '¶', dagger: '†', Dagger: '‡', prime: '′', Prime: '″', times: '×',
	divide: '÷', minus: '−', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾', euro: '€', pound: '£', yen: '¥', cent: '¢',
	iexcl: '¡', iquest: '¿', aacute: 'á', Aacute: 'Á', agrave: 'à', Agrave: 'À', acirc: 'â', auml: 'ä', Auml: 'Ä', atilde: 'ã',
	aring: 'å', aelig: 'æ', ccedil: 'ç', Ccedil: 'Ç', eacute: 'é', Eacute: 'É', egrave: 'è', Egrave: 'È', ecirc: 'ê', euml: 'ë',
	iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï', ntilde: 'ñ', Ntilde: 'Ñ', oacute: 'ó', Oacute: 'Ó', ograve: 'ò', ocirc: 'ô',
	ouml: 'ö', Ouml: 'Ö', otilde: 'õ', oslash: 'ø', szlig: 'ß', uacute: 'ú', Uacute: 'Ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü',
	Uuml: 'Ü', yacute: 'ý', yuml: 'ÿ', oelig: 'œ', OElig: 'Œ', scaron: 'š', Scaron: 'Š',
};
// Numeric references 128-159 mean Windows-1252 characters, as browsers read them.
const CP1252: Record<number, string> = {
	128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡', 136: 'ˆ', 137: '‰', 138: 'Š', 139: '‹', 140: 'Œ',
	142: 'Ž', 145: '‘', 146: '’', 147: '“', 148: '”', 149: '•', 150: '–', 151: '—', 152: '˜', 153: '™', 154: 'š', 155: '›',
	156: 'œ', 158: 'ž', 159: 'Ÿ',
};

export function decodeEntities(text: string): string {
	return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);?/gi, (whole, body: string) => {
		if (body[0] === '#') {
			const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			if (CP1252[code]) {
				return CP1252[code];
			}
			return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
		}
		const named = NAMED[body];
		return named !== undefined && (whole.endsWith(';') || /^(amp|lt|gt|quot|nbsp)$/.test(body)) ? named : whole;
	});
}

const TOKEN = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
// Content never shown as text.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'xmp', 'noembed', 'noframes', 'noscript', 'iframe', 'title']);
// Page furniture dropped with everything inside it.
const DROP = new Set(['nav', 'footer', 'template', 'svg', 'math', 'form', 'button', 'select', 'object', 'canvas', 'video', 'audio', 'dialog', 'menu']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const BLOCK = new Set([
	'p', 'div', 'section', 'article', 'main', 'header', 'aside', 'figure', 'figcaption', 'address', 'dl', 'dt', 'dd',
	'table', 'thead', 'tbody', 'tfoot', 'caption', 'details', 'summary', 'center', 'ul', 'ol', 'body', 'html', 'hgroup',
]);
// Class or id words that mark sharing bars, cookie banners and the like.
const FURNITURE = /(?:^|[\s_-])(?:cookies?|consent|newsletter|share|sharing|social|advert|advertisement|ads|promo|breadcrumbs?|sidebar|related|comments?|subscribe|skip-link|visually-hidden|sr-only|footer|navbar|nav|menu|masthead|toolbar|editsection)(?=$|[\s_-])/i;
// Short blocks that are mostly link text are menus, language lists and
// category links (Readability's link-density test).
const MENU_MAX_CHARS = 120;
const MENU_LINK_SHARE = 0.75;
const NO_FURNITURE_CHECK = new Set(['html', 'body', 'main', 'article']);

function attr(attrs: string, name: string): string | undefined {
	const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
	return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : undefined;
}

export interface PageMeta {
	title: string;
	authors: string[];
	published: string;
	site: string;
	doi: string;
}

interface Block {
	text: string;
	linkShare: number; // share of the block's letters inside <a href>
	region: number; // 2 inside <main>, 1 inside <article>, 0 elsewhere
	heading: number; // 1..6 for headings, 0 otherwise
}

interface Rendered {
	blocks: Block[];
	meta: PageMeta;
}

// One pass over the tags. Text is decoded only after tags are removed, so an
// escaped "&lt;script&gt;" in the page stays text.
function render(html: string, dropFurniture: boolean): Rendered {
	const meta: PageMeta = { title: '', authors: [], published: '', site: '', doi: '' };
	const metaTags: Record<string, string[]> = {};
	const blocks: Block[] = [];
	let buffer = '';
	let prefix = '';
	let heading = 0;
	// Open tags of the subtree being dropped, all with the name that started it.
	const dropStack: string[] = [];
	let main = 0;
	let article = 0;
	let quoteDepth = 0;
	let pre = 0;
	let preText = '';
	const lists: Array<{ ordered: boolean; n: number }> = [];
	let cell = 0;
	let link = 0;
	let linkChars = 0;
	let allChars = 0;

	const flush = () => {
		const text = buffer.replace(/[ \t\n\r\f\v    ]+/g, ' ').replace(/ ?\u0000 ?/g, '\n').trim();
		buffer = '';
		const linkShare = allChars ? linkChars / allChars : 0;
		linkChars = allChars = 0;
		if (text) {
			const quote = '> '.repeat(quoteDepth);
			blocks.push({ text: quote + prefix + text.split('\n').join('\n' + quote), region: main ? 2 : article ? 1 : 0, heading, linkShare });
			prefix = ''; // kept until used, so <li><p>text</p></li> still gets its "- "
		}
	};

	TOKEN.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = TOKEN.exec(html))) {
		const token = m[0];
		const name = m[2]?.toLowerCase();
		if (!name) {
			if (token.startsWith('<!') || token.startsWith('<?')) {
				continue;
			}
			if (dropStack.length) {
				continue;
			}
			const text = decodeEntities(token);
			if (pre) {
				preText += text;
			} else {
				buffer += text;
				const letters = text.replace(/\s+/g, '').length;
				allChars += letters;
				linkChars += link ? letters : 0;
			}
			continue;
		}
		const closing = m[1] === '/';
		const attrs = m[3] ?? '';

		if (!closing && RAW_TEXT.has(name)) {
			const end = new RegExp(`</${name}\\s*>`, 'ig');
			end.lastIndex = TOKEN.lastIndex;
			const close = end.exec(html);
			const inner = html.slice(TOKEN.lastIndex, close ? close.index : html.length);
			TOKEN.lastIndex = close ? end.lastIndex : html.length;
			if (name === 'title' && !meta.title && !dropStack.length) {
				meta.title = decodeEntities(inner).replace(/\s+/g, ' ').trim();
			}
			continue;
		}
		if (name === 'meta' && !closing) {
			const key = (attr(attrs, 'name') ?? attr(attrs, 'property') ?? '').toLowerCase();
			const content = attr(attrs, 'content')?.trim();
			if (key && content) {
				(metaTags[key] ??= []).push(content);
			}
			continue;
		}

		// Dropped subtrees: count only the tag that opened the drop, so a
		// stray </div> inside a <nav> cannot end it early.
		if (dropStack.length) {
			if (name === dropStack[0]) {
				if (closing) {
					dropStack.pop();
				} else if (!attrs.trimEnd().endsWith('/')) {
					dropStack.push(name);
				}
			}
			continue;
		}
		if (!closing && !VOID.has(name)) {
			const hidden = /(?:^|\s)hidden(?:\s|=|$)/i.test(attrs) || attr(attrs, 'aria-hidden') === 'true';
			const furniture = dropFurniture && !NO_FURNITURE_CHECK.has(name) && FURNITURE.test(`${attr(attrs, 'class') ?? ''} ${attr(attrs, 'id') ?? ''}`);
			const role = attr(attrs, 'role');
			if (DROP.has(name) || hidden || furniture || role === 'navigation' || role === 'banner' || role === 'contentinfo') {
				if (!attrs.trimEnd().endsWith('/')) {
					dropStack.push(name);
				}
				continue;
			}
		}

		if (name === 'pre') {
			if (!closing) {
				flush();
				pre++;
				preText = '';
			} else if (pre) {
				pre--;
				const code = preText.replace(/^\n/, '').replace(/\s+$/, '');
				if (code) {
					blocks.push({ text: '```\n' + code + '\n```', region: main ? 2 : article ? 1 : 0, heading: 0, linkShare: 0 });
				}
			}
			continue;
		}
		if (pre) {
			if (name === 'br') {
				preText += '\n';
			}
			continue;
		}

		const level = /^h([1-6])$/.exec(name);
		if (level) {
			flush();
			if (!closing) {
				heading = Number(level[1]);
				prefix = '#'.repeat(heading) + ' ';
			} else {
				heading = 0;
			}
			continue;
		}
		switch (name) {
			case 'br':
				buffer += '\u0000';
				continue;
			case 'hr':
				flush();
				blocks.push({ text: '---', region: main ? 2 : article ? 1 : 0, heading: 0, linkShare: 0 });
				continue;
			case 'img':
				continue;
			case 'a':
				if (closing) {
					link = Math.max(0, link - 1);
				} else if (attr(attrs, 'href') !== undefined) {
					link++;
				}
				continue;
			case 'li':
				flush();
				if (!closing) {
					const list = lists[lists.length - 1];
					const indent = '  '.repeat(Math.max(0, lists.length - 1));
					prefix = indent + (list?.ordered ? `${++list.n}. ` : '- ');
				}
				continue;
			case 'ul':
			case 'ol':
				flush();
				if (closing) {
					lists.pop();
				} else {
					lists.push({ ordered: name === 'ol', n: 0 });
				}
				continue;
			case 'blockquote':
				flush();
				quoteDepth = Math.max(0, quoteDepth + (closing ? -1 : 1));
				continue;
			case 'tr':
				flush();
				cell = 0;
				continue;
			case 'td':
			case 'th':
				if (!closing && cell++ > 0) {
					buffer += ' | ';
				}
				continue;
			case 'main':
				flush();
				main = Math.max(0, main + (closing ? -1 : 1));
				continue;
			case 'article':
				flush();
				article = Math.max(0, article + (closing ? -1 : 1));
				continue;
		}
		if (BLOCK.has(name) || attr(attrs, 'role') === 'main') {
			flush();
		}
	}
	flush();

	const first = (...keys: string[]) => keys.map(k => metaTags[k]?.[0]).find(Boolean) ?? '';
	meta.title = first('citation_title', 'dc.title', 'og:title') || meta.title;
	meta.authors = metaTags['citation_author'] ?? metaTags['dc.creator'] ?? (first('author', 'article:author') ? [first('author', 'article:author')] : []);
	meta.authors = meta.authors.filter(a => !/^https?:/i.test(a));
	meta.published = first('citation_publication_date', 'citation_date', 'dc.date', 'article:published_time', 'date');
	meta.site = first('citation_journal_title', 'og:site_name');
	meta.doi = first('citation_doi', 'dc.identifier').replace(/^doi:\s*/i, '');
	const h1 = blocks.find(b => b.heading === 1)?.text.replace(/^#+ /, '').trim() ?? '';
	// "Human-in-the-loop - Wikipedia": the page's own H1 is the better title.
	if (!meta.title || (h1 && h1.length < meta.title.length && meta.title.startsWith(h1) && /^\s*[-–—|:·•]\s*\S/.test(meta.title.slice(h1.length)))) {
		meta.title = h1 || meta.title;
	}
	return { blocks, meta };
}

function isMenu(b: Block): boolean {
	return !b.heading && b.linkShare >= MENU_LINK_SHARE && b.text.length <= MENU_MAX_CHARS;
}

function chooseBlocks(all: Block[]): Block[] {
	const blocks = all.filter(b => !isMenu(b));
	const chars = (bs: Block[]) => bs.reduce((n, b) => n + b.text.length, 0);
	for (const region of [2, 1]) {
		const inside = blocks.filter(b => b.region >= region);
		if (chars(inside) >= MIN_REGION_CHARS) {
			return inside;
		}
	}
	return blocks;
}

// "Matt Carlson" -> "Carlson, Matt". Already inverted names stay as they are.
export function invertName(name: string): string {
	const n = name.replace(/\s+/g, ' ').trim();
	if (n.includes(',') || !n.includes(' ')) {
		return n;
	}
	const parts = n.split(' ');
	return `${parts.pop()}, ${parts.join(' ')}`;
}

function isoDate(d: Date | string): string {
	if (typeof d === 'string') {
		return /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : d;
	}
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(iso: string): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
}

const yaml = (s: string) => JSON.stringify(s);

// Text that would start a tag in Markdown is escaped, so captured pages
// render their words and never run as HTML in the preview.
function escapeTags(text: string): string {
	return text.replace(/<(?=[a-zA-Z/!?])/g, '\\<');
}

export function htmlToReadableMarkdown(html: string, url: string, accessedDate: Date | string): string {
	return pageToMarkdown(html, url, accessedDate).markdown;
}

export function pageToMarkdown(html: string, url: string, accessedDate: Date | string): { markdown: string; title: string } {
	let { blocks, meta } = render(html, true);
	let chosen = chooseBlocks(blocks);
	if (chosen.reduce((n, b) => n + b.text.length, 0) < MIN_REGION_CHARS) {
		// The class-name heuristics took too much: render again without them.
		({ blocks, meta } = render(html, false));
		chosen = chooseBlocks(blocks);
	}
	const title = meta.title || (() => { try { return new URL(url).hostname; } catch { return url; } })();
	// The page's own H1 usually repeats the title.
	const firstH1 = chosen.findIndex(c => c.heading === 1);
	const body = chosen.filter((b, i) => !(i === firstH1 && b.text.replace(/^# /, '').trim().toLowerCase() === title.toLowerCase()));

	const accessed = isoDate(accessedDate);
	const year = /\b((?:1[89]|20)\d{2})\b/.exec(meta.published)?.[1];
	const author = meta.authors[0] ? invertName(meta.authors[0]) : '';
	// "Surname, Given (Year). Title" lets the readings index read author and year.
	const h1 = author ? `${author}${year ? ` (${year})` : ''}. ${title}` : title;

	const front = ['---', `title: ${yaml(title)}`];
	if (meta.authors.length) {
		front.push(`author: ${yaml(meta.authors.map(invertName).join('; '))}`);
	}
	if (meta.published) {
		front.push(`published: ${yaml(meta.published)}`);
	}
	if (meta.site) {
		front.push(`site: ${yaml(meta.site)}`);
	}
	if (meta.doi) {
		front.push(`doi: ${yaml(meta.doi)}`);
	}
	front.push(`source_url: ${yaml(url)}`, `accessed: ${yaml(accessed)}`, '---');

	const lines = [
		front.join('\n'),
		`# ${escapeTags(h1)}`,
		`Source: <${url}> (accessed ${longDate(accessed)})`,
		...body.map(b => (b.text.startsWith('```') ? b.text : escapeTags(b.text))),
	];
	return { markdown: lines.join('\n\n') + '\n', title };
}

export function plainTextToHtml(text: string, title: string): string {
	const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	return `<title>${esc(title)}</title>` + text.split(/\r?\n\s*\r?\n/).map(p => `<p>${esc(p)}</p>`).join('');
}

// ---------------------------------------------------------------------------
// Fetching

export interface FetchedPage {
	kind: 'html' | 'text' | 'pdf';
	finalUrl: string;
	text: string; // html or plain text; empty for PDFs
	bytes: Uint8Array; // raw body
}

function charsetOf(contentType: string, head: Uint8Array): string {
	const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
	if (fromHeader) {
		return fromHeader;
	}
	const ascii = new TextDecoder('latin1').decode(head.slice(0, 4096));
	return /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(ascii)?.[1] ?? 'utf-8';
}

function decode(bytes: Uint8Array, charset: string): string {
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return new TextDecoder('utf-8').decode(bytes);
	}
}

async function readCapped(response: Response, max: number): Promise<Uint8Array> {
	const length = Number(response.headers.get('content-length') ?? 0);
	if (length > max) {
		throw new Error(`the page is larger than ${Math.round(max / 1024 / 1024)} MB`);
	}
	if (!response.body) {
		return new Uint8Array(await response.arrayBuffer());
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.byteLength;
		if (total > max) {
			await reader.cancel();
			throw new Error(`the page is larger than ${Math.round(max / 1024 / 1024)} MB`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}

export async function fetchPage(url: string, fetchImpl: typeof fetch = fetch): Promise<FetchedPage> {
	if (!isHttpUrl(url)) {
		throw new Error('only http:// and https:// addresses can be captured');
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetchImpl(url, {
			redirect: 'follow',
			signal: controller.signal,
			headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/pdf;q=0.8,*/*;q=0.5' },
		});
		const finalUrl = response.url && isHttpUrl(response.url) ? response.url : url;
		if (!response.ok) {
			throw new Error(`the server answered HTTP ${response.status}`);
		}
		const type = (response.headers.get('content-type') ?? '').toLowerCase();
		if (type.includes('application/pdf') || /\.pdf(?:$|[?#])/i.test(new URL(finalUrl).pathname) && !type.includes('html')) {
			return { kind: 'pdf', finalUrl, text: '', bytes: await readCapped(response, MAX_PDF_BYTES) };
		}
		if (type && !/(?:text\/html|application\/xhtml\+xml|text\/plain)/.test(type)) {
			throw new Error(`it is ${type.split(';')[0]}, not a web page`);
		}
		const bytes = await readCapped(response, MAX_PAGE_BYTES);
		const text = decode(bytes, charsetOf(type, bytes));
		return { kind: type.includes('text/plain') ? 'text' : 'html', finalUrl, text, bytes };
	} catch (err) {
		if ((err as Error).name === 'AbortError') {
			throw new Error(`no answer within ${FETCH_TIMEOUT_MS / 1000} seconds`);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Saving

export function captureSlug(title: string, url: string): string {
	let host = '';
	try {
		host = new URL(url).hostname.replace(/^www\./, '');
	} catch {
		// keep empty
	}
	return slugify(title, 60) || slugify(host, 60) || 'page';
}

// Never overwrites: "slug.md", then "slug-2.md", "slug-3.md", ...
export function writeUnique(dir: string, slug: string, ext: string, content: string | Uint8Array): string {
	fs.mkdirSync(dir, { recursive: true });
	for (let n = 1; ; n++) {
		const file = path.join(dir, `${slug}${n === 1 ? '' : `-${n}`}${ext}`);
		try {
			fs.writeFileSync(file, content, { flag: 'wx' });
			return file;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw err;
			}
		}
	}
}

export interface CaptureResult {
	file: string;
	kind: FetchedPage['kind'];
	title: string;
}

export async function capturePage(url: string, workspaceDir: string, accessed: Date | string, fetchImpl: typeof fetch = fetch): Promise<CaptureResult> {
	const page = await fetchPage(url, fetchImpl);
	const dir = path.join(workspaceDir, SOURCES_DIR);
	if (page.kind === 'pdf') {
		const name = decodeURIComponent(path.basename(new URL(page.finalUrl).pathname)).replace(/\.pdf$/i, '');
		const file = writeUnique(dir, slugify(name, 60) || captureSlug('', page.finalUrl), '.pdf', page.bytes);
		return { file, kind: 'pdf', title: name };
	}
	const html = page.kind === 'text' ? plainTextToHtml(page.text, path.basename(new URL(page.finalUrl).pathname)) : page.text;
	const { markdown, title } = pageToMarkdown(html, page.finalUrl, accessed);
	const file = writeUnique(dir, captureSlug(title, page.finalUrl), '.md', markdown);
	return { file, kind: page.kind, title };
}

// ---------------------------------------------------------------------------
// Commands

export interface ResearchBrowserDeps {
	onSourceCaptured: (file: string) => void;
	openPdf: (uri: vscodeTypes.Uri) => Thenable<unknown> | Promise<unknown>;
	fetchImpl?: typeof fetch;
	now?: () => Date;
}

export class ResearchBrowser {
	lastUrl = '';

	constructor(private readonly vscode: typeof vscodeTypes, private readonly deps: ResearchBrowserDeps) {}

	private async suggestions(arg: unknown): Promise<string> {
		const editor = this.vscode.window.activeTextEditor;
		const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : undefined;
		let clipboard: string | undefined;
		try {
			clipboard = await this.vscode.env.clipboard.readText();
		} catch {
			clipboard = undefined;
		}
		return defaultUrl([typeof arg === 'string' ? arg : undefined, selected, clipboard, this.lastUrl]);
	}

	private async askUrl(arg: unknown, prompt: string): Promise<string | undefined> {
		if (isHttpUrl(arg)) {
			return arg.trim();
		}
		const value = await this.vscode.window.showInputBox({
			prompt,
			value: await this.suggestions(arg),
			placeHolder: 'https://',
			ignoreFocusOut: true,
			validateInput: v => (isHttpUrl(normalizeUrlInput(v)) ? null : 'Enter an http:// or https:// address.'),
		});
		const url = value === undefined ? undefined : normalizeUrlInput(value);
		return url && isHttpUrl(url) ? url : undefined;
	}

	async openBeside(arg?: unknown): Promise<void> {
		const { vscode } = this;
		const url = await this.askUrl(arg, 'Page to open beside the draft');
		if (!url) {
			return;
		}
		this.lastUrl = url;
		// Both browser routes open in the active group (the integrated browser
		// ignores a requested column), so make a column at the far right first:
		// the page never covers the draft or the PDF.
		await vscode.commands.executeCommand('workbench.action.focusLastEditorGroup');
		await vscode.commands.executeCommand('workbench.action.newGroupRight');
		try {
			await vscode.commands.executeCommand('simpleBrowser.api.open', vscode.Uri.parse(url), { viewColumn: vscode.ViewColumn.Active, preserveFocus: false });
		} catch {
			await vscode.commands.executeCommand('simpleBrowser.show', url);
		}
	}

	async capture(arg?: unknown): Promise<CaptureResult | undefined> {
		const { vscode } = this;
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			vscode.window.showWarningMessage('VSwriter: open the assignment folder first. Captured pages are saved in its sources folder.');
			return undefined;
		}
		const url = await this.askUrl(arg, 'Page to capture into sources/ as Markdown');
		if (!url) {
			return undefined;
		}
		this.lastUrl = url;
		const running = capturePage(url, folder.uri.fsPath, (this.deps.now ?? (() => new Date()))(), this.deps.fetchImpl);
		vscode.window.setStatusBarMessage(`VSwriter: capturing ${new URL(url).hostname}`, running);
		let result: CaptureResult;
		try {
			result = await running;
		} catch (err) {
			vscode.window.showWarningMessage(`VSwriter: could not capture ${url}: ${(err as Error).message}.`);
			return undefined;
		}
		const uri = vscode.Uri.file(result.file);
		if (result.kind === 'pdf') {
			await this.deps.openPdf(uri);
		} else {
			const doc = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
		}
		vscode.window.setStatusBarMessage(`VSwriter: saved ${path.join(SOURCES_DIR, path.basename(result.file))}`, 5000);
		this.deps.onSourceCaptured(result.file);
		return result;
	}
}

export function registerResearchBrowser(vscode: typeof vscodeTypes, deps: ResearchBrowserDeps): { browser: ResearchBrowser; disposables: vscodeTypes.Disposable[] } {
	const browser = new ResearchBrowser(vscode, deps);
	return {
		browser,
		disposables: [
			vscode.commands.registerCommand('writerStudio.openBrowserBeside', (url?: unknown) => browser.openBeside(url)),
			vscode.commands.registerCommand('writerStudio.captureWebPage', (url?: unknown) => browser.capture(url)),
		],
	};
}
