// v0.3 units and integration: PDF annotation store, the PDF reader custom
// editor (against a fake vscode passed in, plus Fable's media/pdf.html when
// present) and the research browser's web-page capture.

import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PdfHostToWebview } from '../src/shared/pdfProtocol';
import { parseCitations } from '../src/core/citationNav';
import { fillTemplate, openPdfBeside, padQuote, parsePdfMessage, PDF_PLACEHOLDERS, PDF_VIEW_TYPE, PdfReaderProvider } from '../src/core/pdfEditor';
import {
	addHighlight, annotationsPath, appendHighlightToSourceMap, citationFor, cleanSelection, deleteBookmark, deleteHighlight,
	emptyAnnotations, formatQuoteForDraft, inferCitation, loadPdfAnnotations, parseAnnotations, pdfKey, sanitizeRects,
	savePdfAnnotations, slugify, sourceMapRow, toggleBookmark, updateHighlightNote,
} from '../src/core/pdfStore';
import { ReadingsIndex } from '../src/core/readingsIndex';
import {
	capturePage, decodeEntities, defaultUrl, fetchPage, htmlToReadableMarkdown, invertName, isHttpUrl, normalizeUrlInput, ResearchBrowser, writeUnique,
} from '../src/core/researchBrowser';
import { analyzeDocument, shouldLint } from '../src/core/slopLinter';
import { SOURCE_MAP_TEMPLATE } from '../src/core/workflowStore';

const EXTENSION_ROOT = path.resolve(import.meta.dir, '..');
const MELLAMPHY_PDF = '/Users/admin/Documents/writing-research/3390F-library/originals/47573d2c5cdb5f5e2103bb99ea9e69d4c5e333eb982fccb7898ec3c4d45e135a/Week 03 — Required — Mellamphy — Humans “in the Loop” - - Human-Centrism, Posthumanism, and AI.pdf';
const MELLAMPHY_NAME = path.basename(MELLAMPHY_PDF);

const temps: string[] = [];
const tmp = (prefix: string) => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temps.push(d);
	return d;
};
afterAll(() => temps.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

const NOW = new Date('2026-11-23T15:00:00.000Z');
const LATER = new Date('2026-11-23T15:05:00.000Z');

// ---------------------------------------------------------------------------

describe('pdfStore: where notes live', () => {
	test('keys are workspace-relative inside the workspace and absolute outside it', () => {
		expect(pdfKey('/ws/readings/Week 3/a.pdf', '/ws')).toBe('readings/Week 3/a.pdf');
		expect(pdfKey('/elsewhere/a.pdf', '/ws')).toBe('/elsewhere/a.pdf');
		expect(pdfKey('/elsewhere/a.pdf')).toBe('/elsewhere/a.pdf');
	});

	test('one plain JSON file per PDF under .vswriter/pdf-notes, or global storage without a workspace', () => {
		const inWs = annotationsPath(MELLAMPHY_PDF, '/ws', '/global');
		expect(path.dirname(inWs)).toBe('/ws/.vswriter/pdf-notes');
		expect(path.basename(inWs)).toMatch(/^week-03-required-mellamphy-humans-in-the-loop-hu-[0-9a-f]{8}\.json$/);
		expect(path.dirname(annotationsPath(MELLAMPHY_PDF, undefined, '/global'))).toBe('/global/pdf-notes');
		// Same name in two folders: two files.
		expect(annotationsPath('/ws/a/x.pdf', '/ws', '/g')).not.toBe(annotationsPath('/ws/b/x.pdf', '/ws', '/g'));
		expect(annotationsPath('/ws/a/x.pdf', '/ws', '/g')).toBe(annotationsPath('/ws/a/x.pdf', '/ws', '/g'));
		expect(slugify('Ça ira — “Déjà vu”!')).toBe('ca-ira-deja-vu');
		expect(path.basename(annotationsPath('/ws/!!!.pdf', '/ws', '/g'))).toMatch(/^pdf-[0-9a-f]{8}\.json$/);
	});
});

describe('pdfStore: pure transforms', () => {
	const input = { page: 3, text: 'Humans should never relinquish moral agency to machines', note: '', color: 'sage' as const, rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.02 }] };

	test('addHighlight returns new data, sorted by page, and never mutates the input', () => {
		const empty = emptyAnnotations('a.pdf');
		const one = addHighlight(empty, input, NOW, 'h1');
		const two = addHighlight(one, { ...input, page: 1, color: 'brick' }, LATER, 'h2');
		expect(empty.highlights).toEqual([]);
		expect(one.highlights).toEqual([{ id: 'h1', ...input, createdAt: NOW.toISOString() }]);
		expect(two.highlights.map(h => [h.id, h.page])).toEqual([['h2', 1], ['h1', 3]]);
	});

	test('invalid highlights are refused and rects are clamped to the page box', () => {
		const empty = emptyAnnotations('a.pdf');
		expect(addHighlight(empty, { ...input, page: 0 })).toBe(empty);
		expect(addHighlight(empty, { ...input, page: 2.5 })).toBe(empty);
		expect(addHighlight(empty, { ...input, text: '   ' })).toBe(empty);
		expect(sanitizeRects([
			{ x: -0.2, y: 0.5, w: 0.5, h: 0.1 },
			{ x: 0.9, y: 0.95, w: 0.5, h: 0.5 },
			{ x: Number.NaN, y: 0, w: 1, h: 1 },
			{ x: 0.1, y: 0.1, w: 0, h: 0.1 },
			'nope',
			{ x: 0.123456789, y: 0.1, w: 0.2, h: 0.1 },
		])).toEqual([
			{ x: 0, y: 0.5, w: 0.5, h: 0.1 },
			{ x: 0.9, y: 0.95, w: 0.1, h: 0.05 },
			{ x: 0.12346, y: 0.1, w: 0.2, h: 0.1 },
		]);
		expect(sanitizeRects('x')).toEqual([]);
	});

	test('notes update, highlights delete, bookmarks toggle one per page', () => {
		let d = addHighlight(emptyAnnotations('a.pdf'), input, NOW, 'h1');
		d = updateHighlightNote(d, 'h1', 'Use against Carlson in para 3');
		expect(d.highlights[0].note).toBe('Use against Carlson in para 3');
		expect(updateHighlightNote(d, 'missing', 'x').highlights).toEqual(d.highlights);
		expect(deleteHighlight(d, 'h1').highlights).toEqual([]);

		d = toggleBookmark(d, 17, '  Loop definition ', NOW, 'b1');
		d = toggleBookmark(d, 4, '', LATER, 'b2');
		expect(d.bookmarks).toEqual([
			{ id: 'b2', page: 4, label: 'Page 4', createdAt: LATER.toISOString() },
			{ id: 'b1', page: 17, label: 'Loop definition', createdAt: NOW.toISOString() },
		]);
		expect(toggleBookmark(d, 17, 'again').bookmarks.map(b => b.page)).toEqual([4]);
		expect(deleteBookmark(d, 'b2').bookmarks.map(b => b.id)).toEqual(['b1']);
		expect(toggleBookmark(d, -1, 'bad')).toBe(d);
	});
});

describe('pdfStore: disk', () => {
	test('save then load round-trips through readable, tab-indented JSON', () => {
		const dir = tmp('pdf-notes-');
		const file = path.join(dir, 'nested', 'x.json');
		let d = addHighlight(emptyAnnotations('readings/x.pdf'), { page: 2, text: 'quoted words', note: '<img src=x onerror=alert(1)>', color: 'ochre', rects: [] }, NOW, 'h1');
		d = toggleBookmark(d, 2, 'Key page', NOW, 'b1');
		savePdfAnnotations(file, d);
		const raw = fs.readFileSync(file, 'utf8');
		expect(raw).toStartWith('{\n\t"version": 1,\n\t"pdf": "readings/x.pdf",');
		expect(raw.endsWith('}\n')).toBe(true);
		expect(loadPdfAnnotations(file, 'ignored')).toEqual(d);
		expect(fs.readdirSync(path.dirname(file))).toEqual(['x.json']); // no temp files left
	});

	test('a missing file loads empty, and an unreadable one is moved aside, never overwritten', () => {
		const dir = tmp('pdf-notes-');
		expect(loadPdfAnnotations(path.join(dir, 'none.json'), 'a.pdf')).toEqual(emptyAnnotations('a.pdf'));
		const file = path.join(dir, 'bad.json');
		fs.writeFileSync(file, '{ "highlights": [ <<<<<<< HEAD');
		expect(loadPdfAnnotations(file, 'a.pdf')).toEqual(emptyAnnotations('a.pdf'));
		const aside = fs.readdirSync(dir).filter(f => f.startsWith('bad.unreadable-'));
		expect(aside.length).toBe(1);
		expect(fs.readFileSync(path.join(dir, aside[0]), 'utf8')).toBe('{ "highlights": [ <<<<<<< HEAD');
	});

	test('hand-edited files are sanitised on load', () => {
		const d = parseAnnotations(JSON.stringify({
			highlights: [{ page: 1, text: 'ok', color: 'neon', rects: [{ x: 2, y: 0, w: 1, h: 1 }] }, { page: 'x', text: 'bad' }],
			bookmarks: [{ page: 5, label: 'a' }, { page: 5, label: 'dupe' }, { page: -2 }],
		}), 'a.pdf', NOW);
		expect(d.highlights.length).toBe(1);
		expect(d.highlights[0]).toMatchObject({ page: 1, text: 'ok', note: '', color: 'ochre', rects: [], createdAt: NOW.toISOString() });
		expect(d.highlights[0].id).toMatch(/^[0-9a-f]{12}$/);
		expect(d.bookmarks.map(b => b.label)).toEqual(['a']);
	});
});

describe('pdfStore: citations and quotes', () => {
	test('author and year come only from author-first file names', () => {
		const cases: Array<[string, string | null]> = [
			['Mellamphy 2021 - Humans in the loop.pdf', 'Mellamphy 2021'],
			['Mellamphy_2021_Humans_in_the_loop.pdf', 'Mellamphy 2021'],
			['Mellamphy2021.pdf', 'Mellamphy 2021'],
			['Carlson, Matt (2015). The robotic reporter.pdf', 'Carlson 2015'],
			['Smith and Jones - 2020 - Platform rules.pdf', 'Smith and Jones 2020'],
			['Smith & Jones 2020.pdf', 'Smith and Jones 2020'],
			['Suzor et al. 2019 Lawless.pdf', 'Suzor et al. 2019'],
			['Week 03 — Required — Mellamphy 2021 — Humans.pdf', 'Mellamphy 2021'],
			['syllabus-W05-Venturini-2019-FromFakeToJunkNews.pdf', 'Venturini 2019'],
			['van Dijk 2013 The culture of connectivity.pdf', 'van Dijk 2013'],
			['Bousfield 2020a.pdf', 'Bousfield 2020'],
			// No author-then-year: the file name is used instead of a guess.
			[MELLAMPHY_NAME, null],
			['Annual Report 2021.pdf', null],
			['Humans in the loop 2021.pdf', null],
			['2021 Mellamphy.pdf', null],
			['Mellamphy 20215.pdf', null],
			['scan0001.pdf', null],
		];
		for (const [name, want] of cases) {
			const c = inferCitation(name);
			expect([name, c ? `${c.author} ${c.year}` : null]).toEqual([name, want]);
		}
	});

	test('citations read "(Author Year: p. X)" or fall back to the file name and PDF page', () => {
		expect(citationFor(17, 'Mellamphy 2021.pdf')).toBe('(Mellamphy 2021: p. 17)');
		expect(citationFor(3, MELLAMPHY_NAME)).toBe('(Week 03 — Required — Mellamphy — Humans “in the Loop” - - Human-Centrism, Posthumanism, and AI, PDF p. 3)');
		// The inferred form is one the citation navigator resolves.
		const [c] = parseCitations('as argued "x" (Mellamphy 2021: p. 17).');
		expect(c).toMatchObject({ surname: 'Mellamphy', year: '2021', pageStart: 17 });
	});

	test('selections lose layout newlines and line-break hyphens, keeping real hyphens', () => {
		expect(cleanSelection('Automated jour-\nnalism  redefines\r\n labor­ and human-\nCentrism')).toBe('Automated journalism redefines labor and human- Centrism');
		expect(cleanSelection('a well-known\tcase')).toBe('a well-known case');
	});

	test('formatQuoteForDraft quotes verbatim, swaps inner quotes and lints clean', () => {
		const q = formatQuoteForDraft('Humans should never\nrelinquish "moral agency" to machines', 17, 'Mellamphy 2021.pdf');
		expect(q).toBe(`"Humans should never relinquish 'moral agency' to machines" (Mellamphy 2021: p. 17)`);
		expect(analyzeDocument(`Mellamphy is blunt: ${q}.`, null)).toEqual([]);
		expect(formatQuoteForDraft('the “loop” matters', 2, 'x.pdf')).toBe('"the ‘loop’ matters" (x, PDF p. 2)');
		const long = Array.from({ length: 120 }, (_, i) => `w${i}`).join(' ');
		expect(formatQuoteForDraft(long, 9, 'Carlson 2015.pdf')).toBe(`> ${long} (Carlson 2015: p. 9)`);
	});

	test('source-map rows escape pipes and fill the template columns', () => {
		expect(sourceMapRow('A | B\nC', 4, 'Carlson 2015.pdf')).toBe('| "A \\| B C" |  | Carlson 2015: p. 4 | Carlson 2015.pdf, PDF p. 4 |');
		expect(sourceMapRow('x', 1, 'notes.pdf')).toBe('| "x" |  |  | notes.pdf, PDF p. 1 |');
	});

	test('appendHighlightToSourceMap creates, appends inside the table, and never rewrites', () => {
		const ws = tmp('srcmap-');
		const file = path.join(ws, 'source-map.md');
		appendHighlightToSourceMap(ws, 'first quote', 3, 'Mellamphy 2021.pdf');
		expect(fs.readFileSync(file, 'utf8')).toBe(SOURCE_MAP_TEMPLATE + '| "first quote" |  | Mellamphy 2021: p. 3 | Mellamphy 2021.pdf, PDF p. 3 |\n');
		appendHighlightToSourceMap(ws, 'second', 4, 'Mellamphy 2021.pdf');
		const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
		expect(lines.slice(-2)).toEqual(['| "first quote" |  | Mellamphy 2021: p. 3 | Mellamphy 2021.pdf, PDF p. 3 |', '| "second" |  | Mellamphy 2021: p. 4 | Mellamphy 2021.pdf, PDF p. 4 |']);

		// The writer added prose under the table: the row starts a new table.
		const before = fs.readFileSync(file, 'utf8') + '\nNotes: check p. 4 against print.';
		fs.writeFileSync(file, before);
		appendHighlightToSourceMap(ws, 'third', 5, 'x.pdf');
		const after = fs.readFileSync(file, 'utf8');
		expect(after.startsWith(before)).toBe(true);
		expect(after.slice(before.length)).toBe('\n\n| Claim | Your interpretation | Source (Author Year: page) | File and line |\n| --- | --- | --- | --- |\n| "third" |  |  | x.pdf, PDF p. 5 |\n');
	});
});

// ---------------------------------------------------------------------------
// PDF reader against a fake vscode

class Uri {
	constructor(readonly fsPath: string, readonly scheme = 'file') {}
	static file(p: string) { return new Uri(p); }
	static parse(s: string) { return new Uri(s, s.split(':')[0]); }
	static joinPath(base: Uri, ...parts: string[]) { return new Uri(path.join(base.fsPath, ...parts)); }
	toString() { return this.scheme === 'file' ? 'file://' + this.fsPath : this.fsPath; }
}
class Position { constructor(readonly line: number, readonly character: number) {} }
class Selection {
	constructor(readonly anchor: Position, readonly active: Position) {}
	get start() { return this.anchor; }
	get end() { return this.active; }
	get isEmpty() { return this.anchor.line === this.active.line && this.anchor.character === this.active.character; }
}

function fakeDoc(fileName: string, initial: string) {
	let text = initial;
	return {
		fileName, uri: Uri.file(fileName), isClosed: false,
		languageId: fileName.endsWith('.md') ? 'markdown' : 'plaintext',
		getText: (sel?: Selection) => {
			if (!sel) {
				return text;
			}
			const lines = text.split('\n');
			return lines[sel.start.line].slice(sel.start.character, sel.end.character);
		},
		lineAt: (i: number) => ({ text: text.split('\n')[i] ?? '' }),
		replace(sel: Selection, s: string) {
			const lines = text.split('\n');
			const off = (p: Position) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
			text = text.slice(0, off(sel.start)) + s + text.slice(off(sel.end));
		},
	};
}

function fakeEditor(doc: ReturnType<typeof fakeDoc>, line: number, from: number, to = from) {
	return {
		document: doc, viewColumn: 1,
		selection: new Selection(new Position(line, from), new Position(line, to)),
		edit: async (cb: (b: { replace(s: Selection, t: string): void }) => void) => { cb({ replace: (s, t) => doc.replace(s, t) }); return true; },
		revealRange() {},
	};
}

function fakeVscode(opts: { workspace?: string; visible?: any[]; commandsImpl?: (id: string, ...args: unknown[]) => unknown } = {}) {
	const log = { infos: [] as string[], warnings: [] as string[], status: [] as string[], clipboard: '', commands: [] as unknown[][], shown: [] as any[] };
	const vscode = {
		Uri, Position, Selection,
		ViewColumn: { Active: -1, Beside: -2 },
		TextEditorRevealType: { InCenter: 2 },
		env: { clipboard: { readText: async () => log.clipboard, writeText: async (t: string) => { log.clipboard = t; } } },
		window: {
			activeTextEditor: undefined as any,
			visibleTextEditors: opts.visible ?? [],
			tabGroups: { all: [{}] },
			showInformationMessage: (m: string) => { log.infos.push(m); },
			showWarningMessage: (m: string) => { log.warnings.push(m); },
			setStatusBarMessage: (m: string) => { log.status.push(m); return { dispose() {} }; },
			showTextDocument: async (doc: any, o: any) => { log.shown.push({ path: doc.fileName, options: o }); return fakeEditor(doc, 0, 0); },
			showInputBox: async (o: any) => o.value,
			showQuickPick: async (items: any[]) => items[1],
			showOpenDialog: async () => undefined,
		},
		workspace: {
			workspaceFolders: opts.workspace ? [{ uri: Uri.file(opts.workspace) }] : undefined,
			findFiles: async () => (opts.workspace ? [Uri.file(path.join(opts.workspace, 'readings', 'Carlson 2015.pdf'))] : []),
			asRelativePath: (u: Uri) => path.relative(opts.workspace ?? '/', u.fsPath),
			openTextDocument: async (u: Uri) => fakeDoc(u.fsPath, fs.readFileSync(u.fsPath, 'utf8')),
		},
		commands: {
			executeCommand: async (id: string, ...args: unknown[]) => { log.commands.push([id, ...args]); return opts.commandsImpl?.(id, ...args); },
		},
	};
	return { vscode: vscode as any, log };
}

function fakePanel() {
	const posted: PdfHostToWebview[] = [];
	let receive: (m: unknown) => Promise<void> = async () => undefined;
	let disposed = () => {};
	const panel = {
		webview: {
			options: {} as any, html: '', cspSource: 'vscode-webview://csp',
			asWebviewUri: (u: Uri) => ({ toString: () => 'vscode-webview://res' + u.fsPath }),
			postMessage: async (m: PdfHostToWebview) => { posted.push(m); return true; },
			onDidReceiveMessage: (cb: (m: unknown) => Promise<void>) => { receive = cb; return { dispose() {} }; },
		},
		onDidDispose: (cb: () => void) => { disposed = cb; return { dispose() {} }; },
	};
	return { panel, posted, send: (m: unknown) => receive(m), dispose: () => disposed() };
}

describe('pdfEditor: template and protocol', () => {
	test('fillTemplate replaces every occurrence of every placeholder', () => {
		const template = PDF_PLACEHOLDERS.map(p => `${p}|${p}`).join('\n');
		const values = Object.fromEntries(PDF_PLACEHOLDERS.map((p, i) => [p, `v${i}$&`])) as any;
		const html = fillTemplate(template, values);
		expect(html).not.toContain('{{');
		expect(html.split('\n')).toEqual(PDF_PLACEHOLDERS.map((_, i) => `v${i}$&|v${i}$&`));
	});

	test('parsePdfMessage accepts each contract message and rejects malformed ones', () => {
		const ok = [
			{ type: 'pdfReady' },
			{ type: 'addHighlight', highlight: { page: 2, text: 't', note: 'n', color: 'brick', rects: [{ x: 0, y: 0, w: 1, h: 1 }] } },
			{ type: 'deleteHighlight', id: 'h' },
			{ type: 'updateHighlightNote', id: 'h', note: '' },
			{ type: 'toggleBookmark', page: 1, label: 'L' },
			{ type: 'deleteBookmark', id: 'b' },
			{ type: 'sendToDraft', text: 't', page: 1, fileName: 'f.pdf' },
			{ type: 'appendToSourceMap', text: 't', page: 1, fileName: 'f.pdf' },
		];
		for (const m of ok) {
			expect(parsePdfMessage(JSON.parse(JSON.stringify(m)))).toEqual(m as any);
		}
		const bad = [
			null, 'pdfReady', {}, { type: 'eval', code: '1' },
			{ type: 'addHighlight', highlight: { page: 2, text: 't', color: 'neon' } },
			{ type: 'addHighlight', highlight: { page: '2', text: 't', color: 'sage' } },
			{ type: 'addHighlight', highlight: { page: 2, text: ' ', color: 'sage' } },
			{ type: 'deleteHighlight', id: 5 },
			{ type: 'updateHighlightNote', id: 'h' },
			{ type: 'toggleBookmark', page: 0 },
			{ type: 'sendToDraft', text: '', page: 1 },
			{ type: 'appendToSourceMap', text: 'x', page: 1.5 },
		];
		for (const m of bad) {
			expect(parsePdfMessage(m)).toBeNull();
		}
		// Missing optional fields get defaults.
		expect(parsePdfMessage({ type: 'addHighlight', highlight: { page: 1, text: 'x', color: 'sage' } })).toEqual({ type: 'addHighlight', highlight: { page: 1, text: 'x', note: '', color: 'sage', rects: [] } });
		expect(parsePdfMessage({ type: 'toggleBookmark', page: 3 })).toEqual({ type: 'toggleBookmark', page: 3, label: '' });
	});

	test('padQuote fits inline quotes into the sentence and sets block quotes apart', () => {
		expect(padQuote('"q" (A 2020: p. 1)', 'She writes', '')).toBe(' "q" (A 2020: p. 1)');
		expect(padQuote('"q" (A 2020: p. 1)', 'She writes ', '.')).toBe('"q" (A 2020: p. 1)');
		expect(padQuote('"q" (c)', '(', 'and')).toBe('"q" (c) ');
		expect(padQuote('> long (c)', 'text before', 'after')).toBe('\n\n> long (c)\n\n');
		expect(padQuote('> long (c)', '', '')).toBe('> long (c)');
	});
});

describe('pdfEditor: custom editor round trip', () => {
	const ws = tmp('pdf-ws-');
	const draft = fakeDoc(path.join(ws, 'essay.md'), 'Mellamphy is blunt: .\nSecond line.');
	const draftEditor = fakeEditor(draft, 0, 'Mellamphy is blunt: '.length);
	const { vscode, log } = fakeVscode({ workspace: ws, visible: [draftEditor] });
	const pdfUri = Uri.file(MELLAMPHY_PDF);
	const provider = new PdfReaderProvider(vscode, { extensionUri: Uri.file(EXTENSION_ROOT) as any, globalStorageDir: tmp('pdf-global-'), draftEditor: () => draftEditor as any });
	const view = fakePanel();
	const last = () => view.posted[view.posted.length - 1];

	test('resolveCustomEditor sets resource roots for the extension, the PDF folder and the workspace', () => {
		provider.goToPage(pdfUri as any, 5); // before the panel exists: becomes initialPage
		provider.resolveCustomEditor(provider.openCustomDocument(pdfUri as any) as any, view.panel as any);
		expect(view.panel.webview.options.enableScripts).toBe(true);
		expect(view.panel.webview.options.localResourceRoots.map((u: Uri) => u.fsPath)).toEqual([EXTENSION_ROOT, path.dirname(MELLAMPHY_PDF), ws]);
	});

	test('the webview HTML is media/pdf.html with every placeholder filled (or the missing-file notice)', () => {
		const html: string = view.panel.webview.html;
		expect(html).not.toContain('{{');
		if (!fs.existsSync(path.join(EXTENSION_ROOT, 'media', 'pdf.html'))) {
			expect(html).toContain('media/pdf.html is missing');
			return;
		}
		const res = (p: string) => 'vscode-webview://res' + path.join(EXTENSION_ROOT, 'media', p);
		expect(html).toContain(res('pdf.css'));
		expect(html).toContain(res('pdf.js'));
		expect(html).toContain(res('vendor/pdf.min.mjs'));
		expect(html).toContain(res('vendor/pdf.worker.min.mjs'));
		expect(html).toContain('vscode-webview://csp');
		const nonces = [...html.matchAll(/nonce(?:-|=")([0-9a-f]{32})/g)].map(m => m[1]);
		expect(nonces.length).toBeGreaterThanOrEqual(2);
		expect(new Set(nonces).size).toBe(1);
		// Strict CSP: no inline handlers or unnonced inline scripts in the template.
		expect(html).not.toMatch(/\son[a-z]+\s*=/i);
		expect(html).not.toMatch(/<script(?![^>]*nonce=)/i);
	});

	test('pdfReady answers with pdfInit: real file name, webview URI, stored data and the pending page', async () => {
		await view.send({ type: 'pdfReady' });
		expect(last()).toEqual({ type: 'pdfInit', fileName: MELLAMPHY_NAME, pdfUri: 'vscode-webview://res' + MELLAMPHY_PDF, highlights: [], bookmarks: [], initialPage: 5 });
		await view.send({ type: 'pdfReady' }); // a webview reload gets no stale jump
		expect(last()).not.toHaveProperty('initialPage');
		provider.goToPage(pdfUri as any, 12);
		expect(last()).toEqual({ type: 'pdfGoToPage', page: 12 });
	});

	test('highlight and bookmark messages persist to .vswriter/pdf-notes and push pdfData', async () => {
		const file = provider.notesFileFor(pdfUri as any);
		expect(file.startsWith(path.join(ws, '.vswriter', 'pdf-notes'))).toBe(true);
		const hostile = '<img src=x onerror=alert(1)>';
		await view.send({ type: 'addHighlight', highlight: { page: 17, text: 'Humans should never relinquish moral agency to machines', note: hostile, color: 'sage', rects: [{ x: 0.1, y: 0.3, w: 0.6, h: 0.02 }] } });
		const data = last() as Extract<PdfHostToWebview, { type: 'pdfData' }>;
		expect(data.type).toBe('pdfData');
		expect(data.highlights).toHaveLength(1);
		expect(data.highlights[0]).toMatchObject({ page: 17, note: hostile, color: 'sage' });
		const id = data.highlights[0].id;

		await view.send({ type: 'updateHighlightNote', id, note: 'para 2 evidence' });
		await view.send({ type: 'toggleBookmark', page: 17, label: 'Agency claim' });
		await view.send({ type: 'toggleBookmark', page: 3, label: '' });
		let saved = JSON.parse(fs.readFileSync(file, 'utf8'));
		expect(saved.pdf).toBe(MELLAMPHY_PDF);
		expect(saved.highlights[0].note).toBe('para 2 evidence');
		expect(saved.bookmarks.map((b: any) => [b.page, b.label])).toEqual([[3, 'Page 3'], [17, 'Agency claim']]);

		await view.send({ type: 'toggleBookmark', page: 3, label: '' });
		await view.send({ type: 'deleteBookmark', id: saved.bookmarks[1].id });
		await view.send({ type: 'deleteHighlight', id });
		saved = JSON.parse(fs.readFileSync(file, 'utf8'));
		expect([saved.highlights, saved.bookmarks]).toEqual([[], []]);
		expect(last()).toEqual({ type: 'pdfData', highlights: [], bookmarks: [] });

		const count = view.posted.length;
		await view.send({ type: 'addHighlight', highlight: { page: -1, text: 'x', color: 'sage' } });
		await view.send({ type: 'runCommand', command: 'workbench.action.terminal.new' });
		expect(view.posted.length).toBe(count);
	});

	test('a hand edit made while the reader is open survives the next change', async () => {
		const file = provider.notesFileFor(pdfUri as any);
		const d = toggleBookmark(loadPdfAnnotations(file, 'x'), 40, 'added by hand', NOW, 'hand');
		savePdfAnnotations(file, d);
		await view.send({ type: 'toggleBookmark', page: 41, label: '' });
		expect(JSON.parse(fs.readFileSync(file, 'utf8')).bookmarks.map((b: any) => b.page)).toEqual([40, 41]);
	});

	test('sendToDraft inserts the formatted quote at the draft cursor, using the host file name', async () => {
		await view.send({ type: 'sendToDraft', text: 'Humans should never\nrelinquish moral agency', page: 17, fileName: 'spoofed 1999.pdf' });
		expect(draft.getText().split('\n')[0]).toBe('Mellamphy is blunt: "Humans should never relinquish moral agency" (Week 03 — Required — Mellamphy — Humans “in the Loop” - - Human-Centrism, Posthumanism, and AI, PDF p. 17).');
		expect(log.status.at(-1)).toBe('VSwriter: quote added to essay.md');
	});

	test('appendToSourceMap writes a row to the workspace source-map.md', async () => {
		await view.send({ type: 'appendToSourceMap', text: 'moral | agency', page: 17, fileName: 'ignored.pdf' });
		const map = fs.readFileSync(path.join(ws, 'source-map.md'), 'utf8');
		expect(map.startsWith(SOURCE_MAP_TEMPLATE)).toBe(true);
		expect(map.trimEnd().split('\n').at(-1)).toBe(`| "moral \\| agency" |  |  | ${MELLAMPHY_NAME}, PDF p. 17 |`);
		expect(log.status.at(-1)).toBe('VSwriter: PDF p. 17 added to source-map.md');
	});

	test('a disposed panel stops receiving messages', async () => {
		view.dispose();
		const count = view.posted.length;
		await view.send({ type: 'pdfReady' });
		expect(view.posted.length).toBe(count);
	});
});

describe('pdfEditor: no draft, no workspace, opening PDFs', () => {
	test('without a draft the quote goes to the clipboard with a VSwriter notice', async () => {
		const { vscode, log } = fakeVscode();
		const provider = new PdfReaderProvider(vscode, { extensionUri: Uri.file(EXTENSION_ROOT) as any, globalStorageDir: tmp('pdf-global-'), draftEditor: () => undefined });
		expect(await provider.sendToDraft('"q" (A 2020: p. 1)')).toBe(false);
		expect(log.clipboard).toBe('"q" (A 2020: p. 1)');
		expect(log.infos).toEqual(['VSwriter: no Markdown draft is open, so the quote and its citation are on the clipboard.']);

		provider.appendToSourceMap(Uri.file('/x/a.pdf') as any, 'q', 1, 'a.pdf');
		expect(log.warnings).toEqual(['VSwriter: open the assignment folder first. source-map.md is kept there.']);
		// Notes for a PDF opened with no folder go to global storage.
		expect(provider.notesFileFor(Uri.file('/x/a.pdf') as any)).toContain(path.join('pdf-notes', 'a-'));
	});

	test('a visible Markdown editor is used when the studio has no draft, and a hidden draft is reopened first', async () => {
		const ws = tmp('pdf-ws-');
		const other = fakeDoc(path.join(ws, 'notes.md'), 'x');
		const otherEditor = fakeEditor(other, 0, 1);
		const { vscode } = fakeVscode({ workspace: ws, visible: [otherEditor] });
		const provider = new PdfReaderProvider(vscode, { extensionUri: Uri.file(EXTENSION_ROOT) as any, globalStorageDir: ws, draftEditor: () => undefined });
		expect(provider.findDraft()).toBe(otherEditor as any);
		expect(await provider.sendToDraft('"q" (c)')).toBe(true);
		expect(other.getText()).toBe('x "q" (c)');

		const hidden = fakeDoc(path.join(ws, 'draft.md'), '');
		const hiddenEditor = fakeEditor(hidden, 0, 0);
		const second = fakeVscode({ workspace: ws, visible: [] });
		const p2 = new PdfReaderProvider(second.vscode, { extensionUri: Uri.file(EXTENSION_ROOT) as any, globalStorageDir: ws, draftEditor: () => hiddenEditor as any });
		await p2.sendToDraft('"q" (c)');
		expect(second.log.shown[0]).toMatchObject({ path: hidden.fileName, options: { preserveFocus: true } });
		expect(hidden.getText()).toBe('"q" (c)');
	});

	test('openPdfBeside opens with the PDF reader in the column beside the draft', async () => {
		const ws = tmp('pdf-ws-');
		const { vscode, log } = fakeVscode({ workspace: ws });
		const provider = new PdfReaderProvider(vscode, { extensionUri: Uri.file(EXTENSION_ROOT) as any, globalStorageDir: ws, draftEditor: () => undefined });
		await openPdfBeside(vscode, provider, Uri.file(MELLAMPHY_PDF), 17);
		expect(log.commands[0]).toEqual(['vscode.openWith', Uri.file(MELLAMPHY_PDF), PDF_VIEW_TYPE, { viewColumn: -2, preserveFocus: false }]);
		// Without a URI: the quick pick lists workspace PDFs (item 0 is "Browse").
		await openPdfBeside(vscode, provider);
		expect((log.commands[1][1] as Uri).fsPath).toBe(path.join(ws, 'readings', 'Carlson 2015.pdf'));
		expect(PDF_VIEW_TYPE).toBe('writerStudio.pdfReader');
	});

	test('the manifest contributes the custom editor, activation events and v0.3 commands', () => {
		const m = JSON.parse(fs.readFileSync(path.join(EXTENSION_ROOT, 'package.json'), 'utf8'));
		expect(m.version).toBe('0.3.0');
		expect(m.activationEvents).toEqual(['onLanguage:markdown', 'onCustomEditor:writerStudio.pdfReader']);
		expect(m.contributes.customEditors).toEqual([{ viewType: 'writerStudio.pdfReader', displayName: 'VSwriter PDF Reader', selector: [{ filenamePattern: '*.pdf' }], priority: 'default' }]);
		const titles = Object.fromEntries(m.contributes.commands.map((c: any) => [c.command, `${c.category}: ${c.title}`]));
		expect(titles['writerStudio.openPdfBeside']).toBe('VSwriter: Open PDF Beside Draft');
		expect(titles['writerStudio.openBrowserBeside']).toBe('VSwriter: Open Research Browser Beside Draft');
		expect(titles['writerStudio.captureWebPage']).toBe('VSwriter: Capture Web Page to Sources');
		expect(fs.readFileSync(path.join(EXTENSION_ROOT, 'src', 'extension.ts'), 'utf8')).not.toMatch(/['`]Writer:/);
	});
});

// ---------------------------------------------------------------------------
// Research browser

const ARTICLE = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>The robotic reporter | Digital Journalism | Taylor &amp; Francis</title>
<meta name="citation_title" content="The Robotic Reporter: Automated journalism and the redefinition of labor">
<meta name="citation_author" content="Carlson, Matt">
<meta name="citation_publication_date" content="2015/05/04">
<meta name="citation_journal_title" content="Digital Journalism">
<meta name="citation_doi" content="10.1080/21670811.2014.976412">
<style>body { color: red }</style>
<script>window.track = "<p>not text</p>";</script>
</head><body>
<a class="skip-link" href="#main">Skip to content</a>
<header role="banner"><nav><ul><li><a href="/">Home</a></li><li>Journals</li></ul></nav></header>
<div class="cookie-banner">We use cookies to improve your experience.</div>
<main id="main">
<article>
<h1>The Robotic Reporter: Automated journalism and the redefinition of labor</h1>
<div class="share-tools"><button>Share</button> Tweet this</div>
<p>This article examines   <em>automated journalism</em>,
the &ldquo;algorithmic processes that convert data into narrative news texts&rdquo; with limited human intervention.</p>
<h2>Labor &amp; authority</h2>
<p>The long-running trope of human versus machine is now complicated by developments in artificial intelligence.&nbsp;Ask whether 3 &lt; 4 and &lt;script&gt;alert(1)&lt;/script&gt; stays text.</p>
<blockquote><p>Journalists define their work against machines.</p></blockquote>
<ul><li><p>First, compositional forms</p></li><li>Second, labor &#8212; and pay&#x2019;s decline</li></ul>
<ol><li>one</li><li>two</li></ol>
<pre><code>if (a &lt; b) {
  report();
}</code></pre>
<p>Line one<br>Line two</p>
<noscript><p>Enable JavaScript</p></noscript>
<svg><title>icon</title><path d="M0"/></svg>
</article>
<aside class="related-articles"><h3>Related</h3><p>Other robots</p></aside>
</main>
<footer><p>© 2015 Taylor &amp; Francis</p></footer>
</body></html>`;

describe('researchBrowser: URLs', () => {
	test('isHttpUrl and normalizeUrlInput', () => {
		expect(isHttpUrl('https://example.org/a?b#c')).toBe(true);
		expect(isHttpUrl(' http://localhost:3000 ')).toBe(true);
		for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.org', 'example.org', '', 'https://', 42, undefined]) {
			expect(isHttpUrl(bad)).toBe(false);
		}
		expect(normalizeUrlInput(' example.org/page ')).toBe('https://example.org/page');
		expect(normalizeUrlInput('www.jstor.org')).toBe('https://www.jstor.org');
		expect(normalizeUrlInput('javascript:alert(1)')).toBe('javascript:alert(1)');
		expect(normalizeUrlInput('not a url')).toBe('not a url');
	});

	test('defaultUrl prefers the argument, then the selection, then the clipboard', () => {
		expect(defaultUrl(['https://a.org', 'https://b.org'])).toBe('https://a.org');
		expect(defaultUrl([undefined, 'See (https://b.org/x).', 'https://c.org'])).toBe('https://b.org/x');
		expect(defaultUrl(['words only', 'javascript:alert(1)', 'https://c.org/p.'])).toBe('https://c.org/p');
		expect(defaultUrl([undefined, ''])).toBe('');
	});
});

describe('researchBrowser: htmlToReadableMarkdown', () => {
	const md = htmlToReadableMarkdown(ARTICLE, 'https://www.tandfonline.com/doi/full/10.1080/21670811.2014.976412', '2026-11-23');

	test('front matter carries title, citation metadata, URL and accessed date', () => {
		expect(md.split('\n---\n')[0]).toBe([
			'---',
			'title: "The Robotic Reporter: Automated journalism and the redefinition of labor"',
			'author: "Carlson, Matt"',
			'published: "2015/05/04"',
			'site: "Digital Journalism"',
			'doi: "10.1080/21670811.2014.976412"',
			'source_url: "https://www.tandfonline.com/doi/full/10.1080/21670811.2014.976412"',
			'accessed: "2026-11-23"',
		].join('\n'));
		expect(md).toContain('\n\n# Carlson, Matt (2015). The Robotic Reporter: Automated journalism and the redefinition of labor\n\n');
		expect(md).toContain('Source: <https://www.tandfonline.com/doi/full/10.1080/21670811.2014.976412> (accessed 23 November 2026)');
	});

	test('scripts, styles, nav, footer, noscript, svg, banners and share bars are gone', () => {
		for (const gone of ['window.track', 'not text', 'color: red', 'Home', 'Journals', 'cookies', 'Skip to content', 'Tweet', 'Share', 'Enable JavaScript', 'icon', '© 2015', 'Other robots']) {
			expect([gone, md.includes(gone)]).toEqual([gone, false]);
		}
	});

	test('headings, paragraphs, lists, quotes and code read cleanly with entities decoded', () => {
		const body = md.split('(accessed 23 November 2026)\n\n')[1];
		expect(body).toBe([
			'This article examines automated journalism, the “algorithmic processes that convert data into narrative news texts” with limited human intervention.',
			'## Labor & authority',
			'The long-running trope of human versus machine is now complicated by developments in artificial intelligence. Ask whether 3 < 4 and \\<script>alert(1)\\</script> stays text.',
			'> Journalists define their work against machines.',
			'- First, compositional forms',
			'- Second, labor — and pay’s decline',
			'1. one',
			'2. two',
			'```\nif (a < b) {\n  report();\n}\n```',
			'Line one\nLine two',
		].join('\n\n') + '\n');
		// The page H1 repeated the title and was dropped from the body: front matter and H1 only.
		expect(md.match(/Automated journalism and the redefinition of labor/g)!.length).toBe(2);
	});

	test('pages without <main> or <article> keep the body; tiny regions fall back to it', () => {
		const plain = htmlToReadableMarkdown('<title>Notes</title><body><h2>Part</h2><p>Some text here.</p></body>', 'https://x.org/n', new Date(2026, 10, 23));
		expect(plain).toContain('title: "Notes"');
		expect(plain).toContain('accessed: "2026-11-23"');
		expect(plain).toEndWith('# Notes\n\nSource: <https://x.org/n> (accessed 23 November 2026)\n\n## Part\n\nSome text here.\n');
		const long = 'Real body text that matters to the essay. '.repeat(12);
		const teaser = htmlToReadableMarkdown(`<body><main><p>Teaser</p></main><div><p>${long}</p></div></body>`, 'https://x.org/t', '2026-11-23');
		expect(teaser).toContain('Teaser');
		expect(teaser).toContain('Real body text');
		// No title anywhere: the host name stands in.
		expect(teaser).toContain('title: "x.org"');
	});

	test('class heuristics that would empty the page are dropped on a second pass', () => {
		const text = 'An article wrapped in a share container by an odd theme. '.repeat(8);
		const md2 = htmlToReadableMarkdown(`<title>Odd</title><body><div class="share-wrapper"><p>${text}</p></div></body>`, 'https://x.org', '2026-11-23');
		expect(md2).toContain('An article wrapped in a share container');
	});

	test('nested dropped elements, stray tags and hostile metadata do not leak or break out', () => {
		const html = '<title>T &quot;x&quot;</title><meta name="author" content="Ann &quot;Q&quot; Lee"><body><nav><div><nav>inner</nav></div>still nav</nav><p>kept</p></body>';
		const out = htmlToReadableMarkdown(html, 'https://x.org/"\n', '2026-11-23');
		expect(out).not.toContain('inner');
		expect(out).not.toContain('still nav');
		expect(out).toContain('title: "T \\"x\\""');
		expect(out).toContain('author: "Lee, Ann \\"Q\\""');
		expect(out).toContain('source_url: "https://x.org/\\"\\n"');
		expect(out).toEndWith('kept\n');
	});

	test('link-only menus, footer ids and edit links go; site suffixes leave the title (live SEP/Wikipedia shapes)', () => {
		const prose = 'Human-in-the-loop (HITL) is used in multiple contexts and can be defined as a model requiring human interaction. '.repeat(3);
		const html = `<title>Human-in-the-loop - Wikipedia</title><body>
			<div id="navbar"><ul><li><a href="/toc">Table of Contents</a></li><li><a href="/new">What's New</a></li></ul></div>
			<div class="langs"><ul><li><a href="/ar">العربية</a></li><li><a href="/ja">日本語</a></li></ul></div>
			<h1>Human-in-the-loop</h1>
			<p>${prose}<a href="/wiki/HITL">HITL</a> appears in <a href="/ml">machine learning</a>.</p>
			<h2>Machine learning<span class="mw-editsection">[<a href="/edit">edit</a>]</span></h2>
			<p><a href="/full">Read the full report</a></p>
			<ol class="references"><li>Minsky, Marvin; Kurzweil, Ray (2013). <a href="/doi">"The society of intelligent veillance"</a>. IEEE International Symposium on Technology and Society, pp. 13–17.</li></ol>
			<div id="footer"><p>Library of Congress Catalog Data: ISSN 1095-5054</p></div>
		</body>`;
		const out = htmlToReadableMarkdown(html, 'https://en.wikipedia.org/wiki/Human-in-the-loop', '2026-11-23');
		expect(out).toContain('title: "Human-in-the-loop"');
		expect(out.match(/^# /gm)!.length).toBe(1);
		for (const gone of ['Table of Contents', 'What', 'العربية', '[edit]', 'Read the full report', 'ISSN']) {
			expect([gone, out.includes(gone)]).toEqual([gone, false]);
		}
		expect(out).toContain('HITL appears in machine learning.');
		expect(out).toContain('## Machine learning\n');
		expect(out).toContain('1. Minsky, Marvin; Kurzweil, Ray (2013). "The society of intelligent veillance".');
		// A title that merely starts with the H1 word keeps its full form.
		expect(htmlToReadableMarkdown('<title>Loops and Humans</title><h1>Loops</h1><p>x</p>', 'https://x.org', '2026-11-23')).toContain('title: "Loops and Humans"');
	});

	test('entity decoding covers named, numeric, hex and Windows-1252 references', () => {
		expect(decodeEntities('&amp;&lt;&gt;&quot;&apos;&mdash;&hellip;&eacute;&#233;&#xE9;&#151;&#146;&#0;&notanentity;&amp')).toBe('&<>"\'—…ééé—’�&notanentity;&');
		expect(invertName('Matt Carlson')).toBe('Carlson, Matt');
		expect(invertName('Carlson, Matt')).toBe('Carlson, Matt');
		expect(invertName('UNESCO')).toBe('UNESCO');
	});

	test('a captured page is indexed as a reading with author, year and verifiable quotes', async () => {
		const ws = tmp('capture-ws-');
		fs.mkdirSync(path.join(ws, 'sources'));
		fs.writeFileSync(path.join(ws, 'sources', 'robotic-reporter.md'), md);
		fs.writeFileSync(path.join(ws, 'draft.md'), 'The long-running trope of human versus machine is now complicated.');
		const index = await ReadingsIndex.build([], [ws]);
		expect(index.docs.map(d => [path.basename(d.filePath), d.author, d.year])).toEqual([['robotic-reporter.md', 'Carlson', '2015']]);
		expect(index.containsQuote('the long-running trope of human versus machine is now complicated by developments in artificial intelligence')).toBe(true);
		expect(index.containsQuote('Journalists define their work against machines')).toBe(true);
		// Captured sources are read, not drafted: no lint, never the quote target.
		expect(shouldLint({ languageId: 'markdown', fileName: path.join(ws, 'sources', 'robotic-reporter.md') } as any)).toBe(false);
		expect(shouldLint({ languageId: 'markdown', fileName: path.join(ws, 'draft.md') } as any)).toBe(true);
		expect(shouldLint({ languageId: 'markdown', fileName: '/Users/x/sources-essay/draft.md' } as any)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Fetch and capture with a fake fetch

function fakeFetch(routes: Record<string, { status?: number; type?: string; body: string | Uint8Array; url?: string }>): typeof fetch {
	return (async (input: string | URL | Request) => {
		const key = String(input);
		const r = routes[key];
		if (!r) {
			throw new TypeError('fetch failed');
		}
		const res = new Response(r.body, { status: r.status ?? 200, headers: r.type ? { 'content-type': r.type } : {} });
		Object.defineProperty(res, 'url', { value: r.url ?? key });
		return res;
	}) as unknown as typeof fetch;
}

describe('researchBrowser: fetch and capture', () => {
	const routes = {
		'https://tandf.example/robot': { type: 'text/html; charset=utf-8', body: ARTICLE },
		'https://old.example/page': { type: 'text/html; charset=windows-1252', body: new Uint8Array([...Buffer.from('<title>Old</title><p>pay'), 0x92, ...Buffer.from('s decline</p>')]) },
		'https://meta.example/page': { type: 'text/html', body: new Uint8Array([...Buffer.from('<meta charset="iso-8859-1"><title>Caf'), 0xe9, ...Buffer.from('</title><p>x</p>')]) },
		'https://short.example/x': { type: 'text/html', body: '<title>Moved</title><p>landed</p>', url: 'https://final.example/landed' },
		'https://papers.example/files/Mellamphy%202021.pdf': { type: 'application/pdf', body: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) },
		'https://text.example/readme.txt': { type: 'text/plain', body: 'First para\nline two.\n\nSecond para & more.' },
		'https://gone.example/': { status: 404, type: 'text/html', body: 'nope' },
		'https://img.example/a.png': { type: 'image/png', body: 'png' },
		'https://huge.example/': { type: 'text/html', body: 'x'.repeat(8 * 1024 * 1024 + 1) },
	};
	const f = fakeFetch(routes);

	test('fetchPage decodes declared charsets and follows the final URL', async () => {
		expect((await fetchPage('https://old.example/page', f)).text).toContain('pay’s decline');
		expect((await fetchPage('https://meta.example/page', f)).text).toContain('Café');
		expect((await fetchPage('https://short.example/x', f)).finalUrl).toBe('https://final.example/landed');
	});

	test('fetchPage refuses errors, non-pages, oversize bodies and non-http URLs', async () => {
		await expect(fetchPage('https://gone.example/', f)).rejects.toThrow('HTTP 404');
		await expect(fetchPage('https://img.example/a.png', f)).rejects.toThrow('image/png, not a web page');
		await expect(fetchPage('https://huge.example/', f)).rejects.toThrow('larger than 8 MB');
		await expect(fetchPage('file:///etc/passwd', f)).rejects.toThrow('only http');
		await expect(fetchPage('https://offline.example/', f)).rejects.toThrow('fetch failed');
	});

	test('capturePage saves sources/<slug>.md and never overwrites an earlier capture', async () => {
		const ws = tmp('capture-ws-');
		const a = await capturePage('https://tandf.example/robot', ws, '2026-11-23', f);
		expect(path.relative(ws, a.file)).toBe('sources/the-robotic-reporter-automated-journalism-and-the-redefiniti.md');
		const first = fs.readFileSync(a.file, 'utf8');
		expect(first).toContain('source_url: "https://tandf.example/robot"');
		const b = await capturePage('https://tandf.example/robot', ws, '2026-11-24', f);
		expect(path.basename(b.file)).toBe('the-robotic-reporter-automated-journalism-and-the-redefiniti-2.md');
		expect(fs.readFileSync(a.file, 'utf8')).toBe(first);
		expect(fs.readFileSync(b.file, 'utf8')).toContain('accessed: "2026-11-24"');

		const moved = await capturePage('https://short.example/x', ws, '2026-11-23', f);
		expect(fs.readFileSync(moved.file, 'utf8')).toContain('source_url: "https://final.example/landed"');
		const text = await capturePage('https://text.example/readme.txt', ws, '2026-11-23', f);
		expect(fs.readFileSync(text.file, 'utf8')).toEndWith('First para line two.\n\nSecond para & more.\n');
	});

	test('a PDF URL is saved as sources/<name>.pdf for the PDF reader', async () => {
		const ws = tmp('capture-ws-');
		const r = await capturePage('https://papers.example/files/Mellamphy%202021.pdf', ws, '2026-11-23', f);
		expect([r.kind, path.relative(ws, r.file)]).toEqual(['pdf', 'sources/mellamphy-2021.pdf']);
		expect([...fs.readFileSync(r.file)]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
	});

	test('writeUnique counts up instead of overwriting', () => {
		const dir = tmp('unique-');
		expect(path.basename(writeUnique(dir, 'a', '.md', '1'))).toBe('a.md');
		expect(path.basename(writeUnique(dir, 'a', '.md', '2'))).toBe('a-2.md');
		expect(path.basename(writeUnique(dir, 'a', '.md', '3'))).toBe('a-3.md');
		expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('1');
	});
});

describe('researchBrowser: commands', () => {
	test('openBeside uses simpleBrowser.api.open in the column beside, defaulting to the clipboard URL', async () => {
		const { vscode, log } = fakeVscode();
		log.clipboard = 'https://plato.stanford.edu/entries/ethics-ai/';
		const browser = new ResearchBrowser(vscode, { onSourceCaptured: () => undefined, openPdf: async () => undefined });
		await browser.openBeside();
		expect(log.commands.slice(0, 2).map(c => c[0])).toEqual(['workbench.action.focusLastEditorGroup', 'workbench.action.newGroupRight']);
		const [id, uri, options] = log.commands[2] as [string, Uri, unknown];
		expect([id, uri.toString(), options]).toEqual(['simpleBrowser.api.open', 'https://plato.stanford.edu/entries/ethics-ai/', { viewColumn: -1, preserveFocus: false }]);
		expect(browser.lastUrl).toBe('https://plato.stanford.edu/entries/ethics-ai/');
	});

	test('openBeside takes a selected URL and falls back to simpleBrowser.show in a new right column', async () => {
		const { vscode, log } = fakeVscode({ commandsImpl: id => { if (id === 'simpleBrowser.api.open') { throw new Error('not found'); } } });
		const doc = fakeDoc('/w/draft.md', 'read https://example.org/essay now');
		vscode.window.activeTextEditor = fakeEditor(doc, 0, 5, 30);
		const browser = new ResearchBrowser(vscode, { onSourceCaptured: () => undefined, openPdf: async () => undefined });
		await browser.openBeside();
		expect(log.commands.map(c => c[0])).toEqual(['workbench.action.focusLastEditorGroup', 'workbench.action.newGroupRight', 'simpleBrowser.api.open', 'simpleBrowser.show']);
		expect(log.commands[3][1]).toBe('https://example.org/essay');
	});

	test('a cancelled or invalid address does nothing', async () => {
		const { vscode, log } = fakeVscode();
		vscode.window.showInputBox = async () => undefined;
		const browser = new ResearchBrowser(vscode, { onSourceCaptured: () => undefined, openPdf: async () => undefined });
		await browser.openBeside();
		vscode.window.showInputBox = async () => 'javascript:alert(1)';
		await browser.openBeside();
		expect(log.commands).toEqual([]);
	});

	test('capture saves into sources/, opens beside the draft and refreshes the readings index', async () => {
		const ws = tmp('capture-ws-');
		const { vscode, log } = fakeVscode({ workspace: ws });
		const captured: string[] = [];
		const browser = new ResearchBrowser(vscode, {
			onSourceCaptured: f => captured.push(f),
			openPdf: async () => undefined,
			fetchImpl: fakeFetch({ 'https://tandf.example/robot': { type: 'text/html', body: ARTICLE } }),
			now: () => new Date(2026, 10, 23),
		});
		const r = await browser.capture('https://tandf.example/robot');
		expect(r?.title).toBe('The Robotic Reporter: Automated journalism and the redefinition of labor');
		expect(captured).toEqual([r!.file]);
		expect(log.shown.at(-1)).toMatchObject({ path: r!.file, options: { viewColumn: -2, preview: false } });
		expect(log.status.at(-1)).toBe('VSwriter: saved sources/the-robotic-reporter-automated-journalism-and-the-redefiniti.md');
		expect(fs.readFileSync(r!.file, 'utf8')).toContain('accessed: "2026-11-23"');
	});

	test('capture of a PDF hands it to the PDF reader; failures and missing folders warn', async () => {
		const ws = tmp('capture-ws-');
		const { vscode, log } = fakeVscode({ workspace: ws });
		const opened: string[] = [];
		const browser = new ResearchBrowser(vscode, {
			onSourceCaptured: () => undefined,
			openPdf: async u => { opened.push(u.fsPath); },
			fetchImpl: fakeFetch({ 'https://p.example/a.pdf': { type: 'application/pdf', body: '%PDF-' }, 'https://gone.example/': { status: 403, type: 'text/html', body: '' } }),
		});
		await browser.capture('https://p.example/a.pdf');
		expect(opened).toEqual([path.join(ws, 'sources', 'a.pdf')]);
		expect(await browser.capture('https://gone.example/')).toBeUndefined();
		expect(log.warnings).toEqual(['VSwriter: could not capture https://gone.example/: the server answered HTTP 403.']);

		const none = fakeVscode();
		await new ResearchBrowser(none.vscode, { onSourceCaptured: () => undefined, openPdf: async () => undefined }).capture('https://x.org');
		expect(none.log.warnings).toEqual(['VSwriter: open the assignment folder first. Captured pages are saved in its sources folder.']);
	});
});
