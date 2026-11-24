// Local course-reading index: parses Knowledge Library markdown and plain
// .md/.txt readings into passages with exact file/line/page provenance, and
// ranks passages against the writer's raw interview answers with BM25.
// No vscode import here, so tests run under plain bun.

import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Bookmark, RawAnswer } from '../shared/protocol';

export type PageKind = 'printed' | 'inferred' | 'pdf' | 'section' | 'none';

export interface Passage {
	id: string;
	doc: number;
	filePath: string;
	line: number; // 1-based line in filePath
	page: string; // display label, see pageLabel()
	pageKind: PageKind;
	printedPage: number | null;
	pdfPage: number | null;
	text: string; // verbatim substring of that line
}

export interface ReadingDoc {
	filePath: string;
	title: string;
	author: string;
	surnames: string[];
	year: string;
	passages: Passage[];
}

// ---------------------------------------------------------------------------
// Text normalisation

const STOPWORDS = new Set((
	'a about above after again against all am an and any are as at be because been before being below between both but by ' +
	'can cannot could did do does doing down during each few for from further had has have having he her here hers herself ' +
	'him himself his how i if in into is it its itself let me more most my myself no nor not of off on once only or other ' +
	'ought our ours ourselves out over own same she should so some such than that the their theirs them themselves then there ' +
	'these they this those through to too under until up very was we were what when where which while who whom why with would ' +
	'you your yours yourself yourselves also just like really thing things kind kinda sort actually basically honestly maybe ' +
	'probably lot lots way ways make makes made get gets got say says said gonna going even much many well still yet one ones ' +
	'two will dont doesnt isnt cant wont thats etc ibid page pages think thought something someone people'
).split(/\s+/));

const SUFFIXES: Array<[string, string]> = [
	['ational', 'ate'], ['izations', 'ize'], ['ization', 'ize'], ['ations', 'ate'], ['ation', 'ate'],
	['nesses', ''], ['ness', ''], ['ments', ''], ['ment', ''], ['ingly', ''], ['ings', ''], ['ing', ''],
	['edly', ''], ['ies', 'y'], ['ied', 'y'], ['ed', ''], ['ly', ''], ['s', ''],
];

// Crude, but applied identically to readings and answers, which is what matters.
export function stem(word: string): string {
	let w = word;
	if (w.length > 4) {
		for (const [suffix, replacement] of SUFFIXES) {
			if (w.endsWith(suffix) && !(suffix === 's' && w.endsWith('ss')) && w.length - suffix.length + replacement.length >= 3) {
				w = w.slice(0, w.length - suffix.length) + replacement;
				break;
			}
		}
	}
	if (w.length > 3 && w.endsWith('e')) {
		w = w.slice(0, -1);
	}
	return w;
}

// Joins OCR line-break hyphenation ("in- creasingly"). Ordinary hyphens split
// words, so "human-in-the-loop" still matches "human in the loop".
function joinHyphens(s: string): string {
	return s.replace(/(\p{L})-\s(\p{L})/gu, '$1$2');
}

export interface Token {
	stem: string;
	surface: string;
	start: number; // offsets into the original text
	end: number;
}

// A word continues across "hyphen + space", the OCR line-break form.
const WORD = /\p{L}[\p{L}'’]*(?:-\s\p{L}[\p{L}'’]*)*/gu;

export function tokenize(text: string): Token[] {
	const out: Token[] = [];
	for (const m of text.matchAll(WORD)) {
		const word = m[0].toLowerCase().replace(/-\s/g, '').replace(/['’]s$/, '').replace(/['’]/g, '');
		if (word.length < 3 || STOPWORDS.has(word)) {
			continue;
		}
		out.push({ stem: stem(word), surface: word, start: m.index!, end: m.index! + m[0].length });
	}
	return out;
}

// Letters and digits only, single spaces. Used for verbatim quote checks.
export function normalizeForMatch(s: string): string {
	return joinHyphens(s.toLowerCase()).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// ---------------------------------------------------------------------------
// Parsing one reading

const UNIT_HEADING = /^## (PDF page|EPUB section|Text section) (\d+)\b/;
const TRANSCRIPT_TIME = /^\*\*\[(\d{1,2}:\d{2}:\d{2})/;
const PLAIN_PAGE_MARKER = /^\s*\[?\s*(?:p\.|page)\s*(\d{1,4})\s*\]?\s*$/i;
const PRINTED_NUMBER = [/^(\d{1,4})$/, /^(\d{1,4})\s{2,}\S/, /\S\s{2,}(\d{1,4})$/];
const SKIP_LINE = /^(?:<|\[View original|- \[|---|\*Visual content|> Source limits|Copyright ©|#)/;
const SKIP_ANYWHERE = /This content downloaded from|jstor\.org\/(?:terms|stable)|^This is a formatted primary-text extraction/i;
const AUTHOR_SKIP = new Set(['week', 'lecture', 'required', 'supplemental', 'optional', 'current', 'syllabus', 'chapter', 'the', 'notes']);
const MIN_PASSAGE_CHARS = 40;
const CHUNK_CHARS = 420;

function detectPrintedNumber(line: string): number | null {
	const t = line.trim();
	if (t.length > 90) {
		return null;
	}
	for (const re of PRINTED_NUMBER) {
		const m = re.exec(t);
		if (m) {
			const n = Number(m[1]);
			return n >= 1 ? n : null;
		}
	}
	return null;
}

export function parseAuthor(title: string): { author: string; surnames: string[] } {
	if (/^Lecture \d{4}-\d{2}-\d{2}/.test(title)) {
		return { author: 'Lecture', surnames: ['Lecture'] };
	}
	const name = "[\\p{Lu}][\\p{L}'’-]+";
	// "Surname, Given ..." with optional second surname word ("De Stefano", "Borras Jr").
	const comma = new RegExp(`^(${name}(?: ${name})?),`, 'u').exec(title);
	if (comma) {
		const surnames = [comma[1]];
		const authorPart = title.split(/\.\s+["“\p{Lu}]/u)[0];
		for (const m of authorPart.matchAll(new RegExp(`\\band (?:${name}\\.? )+?(${name})(?=[,.]|$)`, 'gu'))) {
			surnames.push(m[1]);
		}
		return { author: comma[1], surnames };
	}
	// "Given Surname — Title" or "Given Surname and Given Surname — Title".
	for (const segment of title.split(/\s+[—–]\s+/)) {
		const s = segment.trim();
		if (/\d/.test(s) || AUTHOR_SKIP.has(s.split(' ')[0].toLowerCase())) {
			continue;
		}
		const people = s.split(/ and /);
		if (people.every(p => new RegExp(`^${name}(?: (?:${name}|\\p{Lu}\\.))*$`, 'u').test(p))) {
			const surnames = people.map(p => p.split(' ').pop()!);
			return { author: surnames[0], surnames };
		}
		break;
	}
	// "syllabus-W02-Suzor-Lawless-author-manuscript", "Braman Change of State ...".
	for (const word of title.split(/[\s_-]+/)) {
		if (/^\p{Lu}\p{Ll}+$/u.test(word) && !AUTHOR_SKIP.has(word.toLowerCase())) {
			return { author: word, surnames: [word] };
		}
	}
	return { author: title.slice(0, 40), surnames: [] };
}

export function parseYear(title: string): string {
	const paren = /\((\d{4})\)/.exec(title) ?? /\b(1[89]\d{2}|20\d{2})\b/.exec(title);
	return paren ? paren[1] : 'n.d.';
}

interface Unit {
	kind: 'pdf' | 'section' | 'none';
	num: number;
	start: number; // 0-based index of the first body line
	end: number; // exclusive
	candidates: number[];
	printed: number | null;
	printedKind: 'printed' | 'inferred' | null;
}

function splitUnits(lines: string[]): Unit[] {
	const units: Unit[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = UNIT_HEADING.exec(lines[i]);
		if (m) {
			if (units.length) {
				units[units.length - 1].end = i;
			}
			units.push({ kind: m[1] === 'PDF page' ? 'pdf' : 'section', num: Number(m[2]), start: i + 1, end: lines.length, candidates: [], printed: null, printedKind: null });
		}
	}
	if (!units.length) {
		let start = 0;
		if (lines[0]?.trim() === '---') {
			const close = lines.indexOf('---', 1);
			start = close > 0 ? close + 1 : 0;
		}
		units.push({ kind: 'none', num: 0, start, end: lines.length, candidates: [], printed: null, printedKind: null });
	}
	return units;
}

// Running heads and page-foot numbers appear on some pages only (often odd
// pages). Keep numbers whose PDF-to-printed offset recurs, then carry that
// offset to unmarked pages.
function assignPrintedPages(units: Unit[], lines: string[]): void {
	const pdfUnits = units.filter(u => u.kind === 'pdf');
	if (!pdfUnits.length) {
		return;
	}
	const offsetCounts = new Map<number, number>();
	for (const u of pdfUnits) {
		for (let i = u.start; i < u.end; i++) {
			const n = detectPrintedNumber(lines[i]);
			if (n !== null) {
				u.candidates.push(n);
			}
		}
		for (const offset of new Set(u.candidates.map(n => n - u.num))) {
			offsetCounts.set(offset, (offsetCounts.get(offset) ?? 0) + 1);
		}
	}
	const unitsWithCandidates = pdfUnits.filter(u => u.candidates.length).length;
	const kept: Array<{ index: number; offset: number }> = [];
	pdfUnits.forEach((u, index) => {
		let best: number | null = null;
		for (const n of u.candidates) {
			const offset = n - u.num;
			const count = offsetCounts.get(offset)!;
			if ((count >= 2 || unitsWithCandidates === 1) && (best === null || count > offsetCounts.get(best)!)) {
				best = offset;
			}
		}
		if (best !== null) {
			u.printed = u.num + best;
			u.printedKind = 'printed';
			kept.push({ index, offset: best });
		}
	});
	if (!kept.length) {
		return;
	}
	const single = kept.every(k => k.offset === kept[0].offset);
	pdfUnits.forEach((u, index) => {
		if (u.printed !== null) {
			return;
		}
		let offset: number | null = null;
		if (single) {
			offset = kept[0].offset;
		} else {
			const prev = [...kept].reverse().find(k => k.index < index);
			const next = kept.find(k => k.index > index);
			if (prev && next && prev.offset === next.offset) {
				offset = prev.offset;
			} else if (prev && index - prev.index <= 2) {
				offset = prev.offset;
			} else if (next && next.index - index <= 2) {
				offset = next.offset;
			}
		}
		if (offset !== null && u.num + offset >= 1) {
			u.printed = u.num + offset;
			u.printedKind = 'inferred';
		}
	});
}

export function pageLabel(kind: PageKind, printed: number | null, pdf: number | null): string {
	switch (kind) {
		case 'printed':
		case 'inferred':
			return String(printed);
		case 'pdf':
			return `PDF ${pdf}`;
		case 'section':
			return `section ${pdf}`;
		default:
			return '';
	}
}

// Sentence-aligned windows of one line; every window is a verbatim substring.
function chunkLine(line: string): string[] {
	const spans: Array<[number, number]> = [];
	const sentenceEnd = /[.!?]+["”’)\]]*\s+/g;
	let start = 0;
	let m: RegExpExecArray | null;
	while ((m = sentenceEnd.exec(line))) {
		const end = m.index + m[0].length;
		if (end - start >= CHUNK_CHARS) {
			spans.push([start, end]);
			start = end;
		}
	}
	if (start < line.length) {
		if (spans.length && line.length - start < MIN_PASSAGE_CHARS * 2) {
			spans[spans.length - 1][1] = line.length;
		} else {
			spans.push([start, line.length]);
		}
	}
	return spans.map(([s, e]) => line.slice(s, e).trim());
}

export function parseReading(filePath: string, content: string, docIndex = 0): ReadingDoc {
	const lines = content.split(/\r?\n/);
	const titleLine = lines.find(l => /^# /.test(l));
	const title = titleLine ? titleLine.slice(2).trim() : path.basename(filePath).replace(/\.(md|txt)$/i, '');
	const { author, surnames } = parseAuthor(title);
	const doc: ReadingDoc = { filePath, title, author, surnames, year: parseYear(title), passages: [] };
	const units = splitUnits(lines);
	assignPrintedPages(units, lines);
	const base = path.basename(filePath).replace(/\.(md|txt)$/i, '');

	for (const u of units) {
		let plainPrinted: number | null = null;
		let clock: string | null = null;
		for (let i = u.start; i < u.end; i++) {
			const line = lines[i];
			if (u.kind === 'none') {
				const marker = PLAIN_PAGE_MARKER.exec(line);
				if (marker) {
					plainPrinted = Number(marker[1]);
					continue;
				}
			}
			const time = TRANSCRIPT_TIME.exec(line);
			if (time) {
				clock = time[1];
			}
			const trimmed = line.trim();
			if (trimmed.length < MIN_PASSAGE_CHARS || SKIP_LINE.test(trimmed) || SKIP_ANYWHERE.test(trimmed) || detectPrintedNumber(trimmed) !== null) {
				continue;
			}
			let kind: PageKind;
			let printed: number | null = null;
			if (u.kind === 'pdf') {
				kind = u.printedKind ?? 'pdf';
				printed = u.printed;
			} else if (u.kind === 'section') {
				kind = 'section';
			} else {
				kind = plainPrinted !== null ? 'printed' : 'none';
				printed = plainPrinted;
			}
			const pdf = u.kind === 'none' ? null : u.num;
			chunkLine(line).forEach((text, k) => {
				if (text.length < MIN_PASSAGE_CHARS) {
					return;
				}
				doc.passages.push({
					id: `${base}:${i + 1}:${k}`,
					doc: docIndex,
					filePath,
					line: i + 1,
					page: clock && kind !== 'pdf' ? clock : pageLabel(kind, printed, pdf),
					pageKind: kind,
					printedPage: printed,
					pdfPage: pdf,
					text,
				});
			});
		}
	}
	return doc;
}

// ---------------------------------------------------------------------------
// Directory scanning

const EXCLUDED_DIRS = new Set(['archive', 'aliases', 'working notes', 'node_modules']);
const EXCLUDED_FILES = new Set(['readme.md', 'agents.md', 'claude.md', 'changelog.md', 'raw-answers.md', 'interview-state.md', 'source-map.md']);
const WORKSPACE_READING_DIR = /^(readings?|sources?|knowledge library)$/i;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export function expandHome(p: string): string {
	return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

async function walk(dir: string, out: string[], inReadingDir: boolean, workspaceMode: boolean): Promise<void> {
	let entries;
	try {
		entries = await fsp.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith('.')) {
			continue;
		}
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!EXCLUDED_DIRS.has(entry.name.toLowerCase())) {
				await walk(full, out, inReadingDir || WORKSPACE_READING_DIR.test(entry.name), workspaceMode);
			}
		} else if (/\.(md|txt)$/i.test(entry.name) && !EXCLUDED_FILES.has(entry.name.toLowerCase())) {
			if (!workspaceMode || inReadingDir) {
				out.push(full);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Index

const K1 = 1.2;
const B = 0.75;
const RECENCY_DECAY = 0.85;
const ANSWERS_CONSIDERED = 8;
const CANDIDATES_PER_ANSWER = 40;
const MAX_PER_READING = 2;
const MAX_PHRASE_GAP_WORDS = 2; // "human in the loop" still counts as one phrase
const NOTE_PENALTY = 0.35;
// Endnotes and reference lists match many words but rarely make an argument.
const NOTE_LINE = /^\s*(?:\d{1,3}\.\s|\[\d{1,3}\])/;

function looksLikeNotes(text: string): boolean {
	return NOTE_LINE.test(text) || (text.match(/\b(?:19|20)\d{2}\b/g) ?? []).length >= 3;
}

interface Match {
	passage: number;
	score: number;
	answer: RawAnswer;
	shared: string[];
	phrase: string | null;
}

export class ReadingsIndex {
	readonly docs: ReadingDoc[] = [];
	readonly passages: Passage[] = [];
	private readonly postings = new Map<string, number[]>(); // passage, tf, passage, tf, ...
	private readonly lengths: number[] = [];
	private totalLength = 0;
	private readonly normalized: string[] = []; // per doc, for quote checks

	// readingDirs are indexed whole. In workspaceDirs only files inside a
	// readings/sources folder count, so the writer's own draft never verifies itself.
	static async build(readingDirs: string[], workspaceDirs: string[] = []): Promise<ReadingsIndex> {
		const files: string[] = [];
		for (const dir of readingDirs) {
			await walk(expandHome(dir), files, true, false);
		}
		for (const dir of workspaceDirs) {
			await walk(dir, files, false, true);
		}
		const index = new ReadingsIndex();
		for (const file of [...new Set(files)].sort()) {
			try {
				const stat = await fsp.stat(file);
				if (stat.size <= MAX_FILE_BYTES) {
					index.add(file, await fsp.readFile(file, 'utf8'));
				}
			} catch {
				// unreadable file: skip it, the rest of the index is still useful
			}
		}
		return index;
	}

	get size(): number {
		return this.passages.length;
	}

	add(filePath: string, content: string): ReadingDoc {
		const doc = parseReading(filePath, content, this.docs.length);
		this.docs.push(doc);
		this.normalized.push(normalizeForMatch(content));
		for (const p of doc.passages) {
			const idx = this.passages.length;
			this.passages.push(p);
			const tokens = tokenize(p.text);
			this.lengths.push(tokens.length);
			this.totalLength += tokens.length;
			const tf = new Map<string, number>();
			for (const t of tokens) {
				tf.set(t.stem, (tf.get(t.stem) ?? 0) + 1);
			}
			for (const [term, count] of tf) {
				let list = this.postings.get(term);
				if (!list) {
					list = [];
					this.postings.set(term, list);
				}
				list.push(idx, count);
			}
		}
		return doc;
	}

	private idf(term: string): number {
		const df = (this.postings.get(term)?.length ?? 0) / 2;
		const n = this.passages.length;
		return Math.log(1 + (n - df + 0.5) / (df + 0.5));
	}

	// True when every fragment of the quote (split at ellipses) appears in one reading.
	containsQuote(quote: string): boolean {
		const fragments = quote.split(/\.\s?\.\s?\.|…|\[\s*\.\.\.\s*\]/).map(normalizeForMatch).filter(f => f.length >= 12);
		if (!fragments.length) {
			return true;
		}
		return this.normalized.some(text => fragments.every(f => text.includes(f)));
	}

	findDocs(surname: string): ReadingDoc[] {
		const want = normalizeForMatch(surname);
		return this.docs.filter(d => d.surnames.some(s => {
			const have = normalizeForMatch(s);
			return have === want || have.split(' ')[0] === want;
		}));
	}

	passagesOnPage(doc: ReadingDoc, page: number): Passage[] {
		const printed = doc.passages.filter(p => p.printedPage === page);
		return printed.length ? printed : doc.passages.filter(p => p.pageKind === 'pdf' && p.pdfPage === page);
	}

	// Plain BM25 over the text's distinct terms: the passages most likely to
	// hold a quotation, best first. Used to snap a near-miss quote.
	searchPassages(text: string, limit = 30): Passage[] {
		const terms = [...new Set(tokenize(text).map(t => t.stem))];
		if (!terms.length || !this.passages.length) {
			return [];
		}
		const avgLength = this.totalLength / this.passages.length;
		const scores = new Map<number, number>();
		const hits = new Map<number, number>();
		for (const term of terms) {
			const list = this.postings.get(term);
			if (!list) {
				continue;
			}
			const idf = this.idf(term);
			for (let i = 0; i < list.length; i += 2) {
				const p = list[i];
				const tf = list[i + 1];
				scores.set(p, (scores.get(p) ?? 0) + idf * tf * (K1 + 1) / (tf + K1 * (1 - B + B * this.lengths[p] / avgLength)));
				hits.set(p, (hits.get(p) ?? 0) + 1);
			}
		}
		const need = Math.min(2, terms.length);
		return [...scores.entries()]
			.filter(([p]) => hits.get(p)! >= need)
			.sort((a, b) => b[1] - a[1])
			.slice(0, limit)
			.map(([p]) => this.passages[p]);
	}

	docOf(passage: Passage): ReadingDoc {
		return this.docs[passage.doc];
	}

	private scoreAnswer(answer: RawAnswer, weight: number): Match[] {
		const tokens = tokenize(answer.text);
		const surface = new Map<string, string>();
		for (const t of tokens) {
			if (!surface.has(t.stem)) {
				surface.set(t.stem, t.surface);
			}
		}
		if (surface.size < 2) {
			return [];
		}
		const avgLength = this.totalLength / Math.max(1, this.passages.length);
		const scores = new Map<number, number>();
		const shared = new Map<number, string[]>();
		for (const term of surface.keys()) {
			const list = this.postings.get(term);
			if (!list) {
				continue;
			}
			const idf = this.idf(term);
			for (let i = 0; i < list.length; i += 2) {
				const p = list[i];
				const tf = list[i + 1];
				const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * this.lengths[p] / avgLength));
				scores.set(p, (scores.get(p) ?? 0) + idf * norm);
				let terms = shared.get(p);
				if (!terms) {
					terms = [];
					shared.set(p, terms);
				}
				terms.push(term);
			}
		}

		const candidates = [...scores.entries()]
			.filter(([p]) => shared.get(p)!.length >= 2)
			.sort((a, b) => b[1] - a[1])
			.slice(0, CANDIDATES_PER_ANSWER);

		// Adjacent content words from the answer that also sit together in the passage.
		const bigrams: Array<{ key: string; phrase: string; bonus: number }> = [];
		for (let i = 1; i < tokens.length; i++) {
			const between = answer.text.slice(tokens[i - 1].end, tokens[i].start).trim();
			if (between.split(/\s+/).length > MAX_PHRASE_GAP_WORDS || /[.!?;:,]/.test(between)) {
				continue;
			}
			bigrams.push({
				key: tokens[i - 1].stem + ' ' + tokens[i].stem,
				phrase: answer.text.slice(tokens[i - 1].start, tokens[i].end).replace(/\s+/g, ' '),
				bonus: (this.idf(tokens[i - 1].stem) + this.idf(tokens[i].stem)) / 2,
			});
		}

		return candidates.map(([p, score]) => {
			const passageTokens = tokenize(this.passages[p].text);
			const passageBigrams = new Set<string>();
			for (let i = 1; i < passageTokens.length; i++) {
				passageBigrams.add(passageTokens[i - 1].stem + ' ' + passageTokens[i].stem);
			}
			let phrase: string | null = null;
			let bestBonus = 0;
			let bonus = 0;
			for (const bg of bigrams) {
				if (passageBigrams.has(bg.key)) {
					bonus += bg.bonus;
					if (bg.bonus > bestBonus) {
						bestBonus = bg.bonus;
						phrase = bg.phrase;
					}
				}
			}
			const terms = shared.get(p)!;
			const coverage = Math.sqrt(terms.length / surface.size);
			const sharedSurface = terms
				.sort((a, b) => this.idf(b) - this.idf(a))
				.map(t => surface.get(t)!);
			const penalty = looksLikeNotes(this.passages[p].text) ? NOTE_PENALTY : 1;
			return { passage: p, score: (score + bonus) * coverage * weight * penalty, answer, shared: sharedSurface, phrase };
		});
	}

	matchBookmarks(rawAnswers: RawAnswer[], maxResults = 6): Bookmark[] {
		if (!this.passages.length || !rawAnswers.length) {
			return [];
		}
		const recent = rawAnswers.slice(-ANSWERS_CONSIDERED).reverse();
		const best = new Map<number, Match>();
		recent.forEach((answer, k) => {
			for (const m of this.scoreAnswer(answer, Math.pow(RECENCY_DECAY, k))) {
				const prev = best.get(m.passage);
				if (!prev || m.score > prev.score) {
					best.set(m.passage, m);
				}
			}
		});

		const perReading = new Map<string, number>();
		const results: Bookmark[] = [];
		for (const m of [...best.values()].sort((a, b) => b.score - a.score)) {
			const p = this.passages[m.passage];
			const doc = this.docs[p.doc];
			// Transcript variants and duplicate extractions share author and year.
			const work = doc.author + ' ' + doc.year;
			const used = perReading.get(work) ?? 0;
			if (used >= MAX_PER_READING) {
				continue;
			}
			perReading.set(work, used + 1);
			results.push({
				id: p.id,
				author: doc.author,
				year: doc.year,
				page: p.page,
				filePath: p.filePath,
				line: p.line,
				excerpt: p.text,
				reason: explainMatch(m, p),
				score: Math.round(m.score * 100) / 100,
			});
			if (results.length >= maxResults) {
				break;
			}
		}
		return results;
	}
}

function shortPrompt(prompt: string): string {
	return prompt.length > 70 ? prompt.slice(0, 67).replace(/\s+\S*$/, '') + '...' : prompt;
}

function listWords(words: string[]): string {
	if (words.length <= 1) {
		return words.join('');
	}
	return words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1];
}

function explainMatch(m: Match, p: Passage): string {
	const where = `your answer to "${shortPrompt(m.answer.prompt)}"`;
	let reason: string;
	if (m.phrase) {
		const inPhrase = new Set(tokenize(m.phrase).map(t => t.surface));
		const others = m.shared.filter(w => !inPhrase.has(w)).slice(0, 3);
		reason = `You wrote "${m.phrase}" in ${where}, and this passage uses the same words together.`;
		if (others.length) {
			reason += ` It also mentions ${listWords(others)}.`;
		}
	} else {
		reason = `This passage uses ${listWords(m.shared.slice(0, 4))}, which you used in ${where}.`;
	}
	reason = reason.charAt(0).toUpperCase() + reason.slice(1);
	if (p.pageKind === 'inferred') {
		reason += ' The page number is counted from the nearest printed page number in this reading.';
	} else if (p.pageKind === 'pdf') {
		reason += ' This reading prints no page number here, so the page shown is the PDF position.';
	}
	return reason;
}
