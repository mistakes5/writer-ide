// Highlights and page bookmarks for one PDF, kept as plain JSON the writer can
// read, diff and export: <workspace>/.vswriter/pdf-notes/<slug>-<hash>.json.
// The transforms are pure (data in, new data out); only load and save touch disk.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { HighlightColor, NormalizedRect, PdfBookmark, PdfHighlight } from '../shared/pdfProtocol';
import { SOURCE_MAP, SOURCE_MAP_TEMPLATE } from './workflowStore';

export const NOTES_DIR = path.join('.vswriter', 'pdf-notes');
export const HIGHLIGHT_COLORS: readonly HighlightColor[] = ['ochre', 'sage', 'brick'];
const FORMAT_VERSION = 1;
const MAX_TEXT = 20_000;
const MAX_NOTE = 5_000;
const MAX_LABEL = 200;
const MAX_RECTS = 400;
// Chicago author-date sets quotations of 100 words or more as block quotes.
const BLOCK_QUOTE_WORDS = 100;

export interface PdfAnnotations {
	version: number;
	pdf: string; // the PDF this file belongs to, workspace-relative when possible
	highlights: PdfHighlight[];
	bookmarks: PdfBookmark[];
}

export type HighlightInput = Omit<PdfHighlight, 'id' | 'createdAt'>;

export function emptyAnnotations(pdf: string): PdfAnnotations {
	return { version: FORMAT_VERSION, pdf, highlights: [], bookmarks: [] };
}

// ---------------------------------------------------------------------------
// Where the notes live

// Workspace-relative when the PDF sits inside the workspace, so notes survive
// cloning the project to another machine. Absolute otherwise.
export function pdfKey(pdfPath: string, workspaceDir?: string): string {
	if (workspaceDir) {
		const rel = path.relative(workspaceDir, pdfPath);
		if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
			return rel.split(path.sep).join('/');
		}
	}
	return path.resolve(pdfPath);
}

export function slugify(text: string, max = 48): string {
	const slug = text
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, max)
		.replace(/-+$/, '');
	return slug;
}

export function notesDir(workspaceDir: string | undefined, globalStorageDir: string): string {
	return workspaceDir ? path.join(workspaceDir, NOTES_DIR) : path.join(globalStorageDir, 'pdf-notes');
}

export function annotationsPath(pdfPath: string, workspaceDir: string | undefined, globalStorageDir: string): string {
	const key = pdfKey(pdfPath, workspaceDir);
	const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
	const slug = slugify(path.basename(pdfPath).replace(/\.pdf$/i, '')) || 'pdf';
	return path.join(notesDir(workspaceDir, globalStorageDir), `${slug}-${hash}.json`);
}

// ---------------------------------------------------------------------------
// Sanitising: the webview and hand-edited files are both untrusted input

function clamp01(n: number): number {
	return Math.min(1, Math.max(0, n));
}

function round(n: number): number {
	return Math.round(n * 1e5) / 1e5;
}

export function sanitizeRects(rects: unknown): NormalizedRect[] {
	if (!Array.isArray(rects)) {
		return [];
	}
	const out: NormalizedRect[] = [];
	for (const r of rects.slice(0, MAX_RECTS)) {
		const { x, y, w, h } = (r ?? {}) as Record<string, unknown>;
		if (![x, y, w, h].every(v => typeof v === 'number' && Number.isFinite(v))) {
			continue;
		}
		const cx = clamp01(x as number);
		const cy = clamp01(y as number);
		const cw = Math.min(clamp01(w as number), 1 - cx);
		const ch = Math.min(clamp01(h as number), 1 - cy);
		if (cw > 0 && ch > 0) {
			out.push({ x: round(cx), y: round(cy), w: round(cw), h: round(ch) });
		}
	}
	return out;
}

function validPage(page: unknown): page is number {
	return typeof page === 'number' && Number.isInteger(page) && page >= 1 && page <= 100_000;
}

function str(value: unknown, max: number): string {
	return typeof value === 'string' ? value.slice(0, max) : '';
}

function isoOr(value: unknown, fallback: string): string {
	return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

function newId(): string {
	return crypto.randomBytes(6).toString('hex');
}

const byPage = <T extends { page: number; createdAt: string }>(a: T, b: T) => a.page - b.page || a.createdAt.localeCompare(b.createdAt);

function sanitizeHighlight(raw: unknown, now: string): PdfHighlight | null {
	const h = (raw ?? {}) as Record<string, unknown>;
	const text = str(h.text, MAX_TEXT);
	if (!validPage(h.page) || !text.trim()) {
		return null;
	}
	return {
		id: typeof h.id === 'string' && h.id ? h.id.slice(0, 64) : newId(),
		page: h.page,
		text,
		note: str(h.note, MAX_NOTE),
		color: HIGHLIGHT_COLORS.includes(h.color as HighlightColor) ? (h.color as HighlightColor) : 'ochre',
		rects: sanitizeRects(h.rects),
		createdAt: isoOr(h.createdAt, now),
	};
}

function sanitizeBookmark(raw: unknown, now: string): PdfBookmark | null {
	const b = (raw ?? {}) as Record<string, unknown>;
	if (!validPage(b.page)) {
		return null;
	}
	return {
		id: typeof b.id === 'string' && b.id ? b.id.slice(0, 64) : newId(),
		page: b.page,
		label: str(b.label, MAX_LABEL).trim() || `Page ${b.page}`,
		createdAt: isoOr(b.createdAt, now),
	};
}

export function parseAnnotations(json: string, pdf: string, now = new Date()): PdfAnnotations {
	const raw = JSON.parse(json) as Record<string, unknown>;
	const stamp = now.toISOString();
	const highlights = (Array.isArray(raw.highlights) ? raw.highlights : [])
		.map(h => sanitizeHighlight(h, stamp))
		.filter((h): h is PdfHighlight => h !== null);
	// One bookmark per page, as toggleBookmark keeps it.
	const bookmarks: PdfBookmark[] = [];
	for (const entry of Array.isArray(raw.bookmarks) ? raw.bookmarks : []) {
		const b = sanitizeBookmark(entry, stamp);
		if (b && !bookmarks.some(o => o.page === b.page)) {
			bookmarks.push(b);
		}
	}
	return { version: FORMAT_VERSION, pdf: typeof raw.pdf === 'string' ? raw.pdf : pdf, highlights: highlights.sort(byPage), bookmarks: bookmarks.sort(byPage) };
}

// ---------------------------------------------------------------------------
// Disk

// A file that no longer parses is moved aside, never overwritten, so a bad
// hand edit or a merge conflict cannot destroy the writer's highlights.
export function loadPdfAnnotations(file: string, pdf: string): PdfAnnotations {
	let json: string;
	try {
		json = fs.readFileSync(file, 'utf8');
	} catch {
		return emptyAnnotations(pdf);
	}
	try {
		return parseAnnotations(json, pdf);
	} catch {
		const aside = `${file.replace(/\.json$/, '')}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
		try {
			fs.renameSync(file, aside);
		} catch {
			// leave it where it is; saving will still not happen over unread data
		}
		return emptyAnnotations(pdf);
	}
}

export function savePdfAnnotations(file: string, data: PdfAnnotations): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, '\t') + '\n', 'utf8');
	fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Pure transforms

export function addHighlight(data: PdfAnnotations, input: HighlightInput, now = new Date(), id = newId()): PdfAnnotations {
	const highlight = sanitizeHighlight({ ...input, id, createdAt: now.toISOString() }, now.toISOString());
	if (!highlight) {
		return data;
	}
	return { ...data, highlights: [...data.highlights, highlight].sort(byPage) };
}

export function deleteHighlight(data: PdfAnnotations, id: string): PdfAnnotations {
	return { ...data, highlights: data.highlights.filter(h => h.id !== id) };
}

export function updateHighlightNote(data: PdfAnnotations, id: string, note: string): PdfAnnotations {
	return { ...data, highlights: data.highlights.map(h => (h.id === id ? { ...h, note: str(note, MAX_NOTE) } : h)) };
}

// One bookmark per page: bookmarking a marked page removes the mark.
export function toggleBookmark(data: PdfAnnotations, page: number, label: string, now = new Date(), id = newId()): PdfAnnotations {
	if (!validPage(page)) {
		return data;
	}
	if (data.bookmarks.some(b => b.page === page)) {
		return { ...data, bookmarks: data.bookmarks.filter(b => b.page !== page) };
	}
	const bookmark = sanitizeBookmark({ id, page, label, createdAt: now.toISOString() }, now.toISOString())!;
	return { ...data, bookmarks: [...data.bookmarks, bookmark].sort(byPage) };
}

export function deleteBookmark(data: PdfAnnotations, id: string): PdfAnnotations {
	return { ...data, bookmarks: data.bookmarks.filter(b => b.id !== id) };
}

// ---------------------------------------------------------------------------
// Citations

// Course prefixes that come before the author in library file names:
// "Week 03 — Required — ", "syllabus-W05-", "R022 ".
const COURSE_PREFIX = /^(?:(?:week|wk|w)\s*\d+|required|suggested|supplemental|optional|syllabus|lecture\s*\d*|r\d{2,4})\s*(?:[—–_-]+\s*|\s+)/i;
const NOT_AUTHOR = new Set([
	'the', 'a', 'an', 'week', 'lecture', 'chapter', 'part', 'volume', 'vol', 'issue', 'report', 'annual', 'notes', 'reading',
	'readings', 'draft', 'final', 'version', 'scan', 'edition', 'spring', 'summer', 'fall', 'autumn', 'winter', 'january',
	'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
]);
const SURNAME = "(?:(?:van|von|de|der|den|da|di|du|le|la)\\s+)*\\p{Lu}[\\p{L}'’]+(?:-\\p{Lu}[\\p{L}'’]+)?";
// "Mellamphy 2021", "Mellamphy_2021_Humans", "Mellamphy2021", "Carlson, Matt (2015)",
// "Smith and Jones - 2020 - Title", "Smith et al. 2019". Author first, year right after:
// a year elsewhere in the name ("Humans in 2021") is not trusted.
const AUTHOR_YEAR = new RegExp(
	`^(${SURNAME})(?:,\\s*(?:\\p{Lu}[\\p{L}.]*\\s*){1,3})?` +
	`(?:[\\s_]+(et[\\s_]*al\\.?|(?:and|&)[\\s_]+${SURNAME}))?` +
	`[\\s_,.()\\[\\]—–-]*((?:1[89]|20)\\d{2})[a-z]?(?!\\d)`,
	'u',
);

export interface InferredCitation {
	author: string; // "Mellamphy", "Smith and Jones", "Smith et al."
	year: string;
}

export function inferCitation(fileName: string): InferredCitation | null {
	let stem = path.basename(fileName).replace(/\.pdf$/i, '').trim();
	for (let guard = 0; guard < 6 && COURSE_PREFIX.test(stem); guard++) {
		stem = stem.replace(COURSE_PREFIX, '');
	}
	const m = AUTHOR_YEAR.exec(stem);
	if (!m || NOT_AUTHOR.has(m[1].toLowerCase())) {
		return null;
	}
	const extra = m[2]?.replace(/_/g, ' ');
	let author = m[1];
	if (extra && /^et/i.test(extra)) {
		author += ' et al.';
	} else if (extra) {
		author += ' ' + extra.replace(/^&/, 'and').replace(/\s+/g, ' ');
	}
	return { author, year: m[3] };
}

export function pdfStem(fileName: string): string {
	return path.basename(fileName).replace(/\.pdf$/i, '');
}

// "(Mellamphy 2021: p. 17)" when the file name names author and year, else
// "(Week 03 — Required — Mellamphy — Humans, PDF p. 3)" for the writer to finish.
// The page is the PDF position. It matches the printed page only when the PDF
// starts at page 1, so the writer checks it against the page header.
export function citationFor(page: number, fileName: string): string {
	const c = inferCitation(fileName);
	return c ? `(${c.author} ${c.year}: p. ${page})` : `(${pdfStem(fileName)}, PDF p. ${page})`;
}

// PDF text layers break lines inside words ("jour-\nnalism") and carry layout
// newlines. Joins those and collapses whitespace; the wording stays as printed.
export function cleanSelection(text: string): string {
	return text
		.replace(/­/g, '')
		.replace(/(\p{Ll})-[ \t]*\r?\n\s*(\p{Ll})/gu, '$1$2')
		.replace(/\s+/g, ' ')
		.trim();
}

export function formatQuoteForDraft(text: string, page: number, fileName: string): string {
	const quote = cleanSelection(text);
	const cite = citationFor(page, fileName);
	if (quote.split(' ').length >= BLOCK_QUOTE_WORDS) {
		return `> ${quote} ${cite}`;
	}
	// Quotation marks inside the quote become single marks.
	return `"${quote.replace(/"/g, "'").replace(/“/g, '‘').replace(/”/g, '’')}" ${cite}`;
}

function cell(text: string): string {
	return text.replace(/\|/g, '\\|');
}

// The row this quote adds to source-map.md, columns as in SOURCE_MAP_TEMPLATE:
// Claim | Your interpretation | Source (Author Year: page) | File and line.
export function sourceMapRow(text: string, page: number, fileName: string): string {
	const c = inferCitation(fileName);
	const source = c ? `${c.author} ${c.year}: p. ${page}` : '';
	return `| "${cell(cleanSelection(text))}" |  | ${cell(source)} | ${cell(path.basename(fileName))}, PDF p. ${page} |`;
}

const TABLE_HEADER = SOURCE_MAP_TEMPLATE.split('\n').filter(l => l.startsWith('|')).join('\n');

// Appends only. When the file no longer ends in the table (the writer added
// prose below it), a fresh header starts a new table so the row still renders.
export function appendHighlightToSourceMap(workspaceDir: string, text: string, page: number, fileName: string): string {
	const file = path.join(workspaceDir, SOURCE_MAP);
	const row = sourceMapRow(text, page, fileName);
	let existing: string | null = null;
	try {
		existing = fs.readFileSync(file, 'utf8');
	} catch {
		// created below
	}
	if (existing === null) {
		fs.writeFileSync(file, SOURCE_MAP_TEMPLATE + row + '\n', { encoding: 'utf8', flag: 'wx' });
		return row;
	}
	const endsInTable = /(?:^|\n)\|[^\n]*\|[ \t]*\n?$/.test(existing);
	const lead = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
	const chunk = endsInTable ? lead + row + '\n' : `${lead}\n${TABLE_HEADER}\n${row}\n`;
	fs.appendFileSync(file, chunk, 'utf8');
	return row;
}
