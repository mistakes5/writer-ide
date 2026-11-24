import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Bookmark, RawAnswer } from '../src/shared/protocol';
import { citationAt, formatHover, parseCitations, resolveCitation } from '../src/core/citationNav';
import { parseAuthor, parseReading, ReadingsIndex, stem, tokenize } from '../src/core/readingsIndex';
import { analyzeDocument } from '../src/core/slopLinter';
import { buildCoaxingStarters, parseRawAnswers, pickQuestion, QUESTIONS, WorkflowStore } from '../src/core/workflowStore';

const LIBRARY = '/Users/admin/Documents/obsidian/school/2026-2027/POLISCI 3390F/Knowledge Library';
const MELLAMPHY = path.join(LIBRARY, 'Week 03/R022.md');
const CARLSON = path.join(LIBRARY, 'Week 04/R031.md');

const fileLine = (file: string, line: number) => fs.readFileSync(file, 'utf8').split(/\r?\n/)[line - 1];
const answer = (text: string, prompt = QUESTIONS[2], id = 'a1'): RawAnswer => ({ id, timestamp: '2026-11-23T12:00:00.000Z', prompt, text });

let library: ReadingsIndex;
beforeAll(async () => {
	library = await ReadingsIndex.build([LIBRARY]);
}, 60_000);

// ---------------------------------------------------------------------------

describe('readingsIndex', () => {
	test('parses Knowledge Library headers into author and year', () => {
		expect(parseAuthor('Mellamphy, Nandita Biswas. "Humans “in the Loop”?: Human-Centrism, Posthumanism, and AI." Nature and Culture 16.1 (2021): 11-27.'))
			.toEqual({ author: 'Mellamphy', surnames: ['Mellamphy'] });
		expect(parseAuthor('Hansen, Lene, and Helen Nissenbaum. "Digital disaster, cyber security, and the Copenhagen School."').surnames)
			.toEqual(['Hansen', 'Nissenbaum']);
		expect(parseAuthor('Manuel Castells — The Rise of the Network Society — Chapter 1').author).toBe('Castells');
		expect(parseAuthor('Jason Dittmer and Daniel Bos — Popular Culture, Geopolitics, and Identity (2019)').surnames).toEqual(['Dittmer', 'Bos']);
		expect(parseAuthor('syllabus-W02-Suzor-Lawless-author-manuscript').author).toBe('Suzor');
		expect(parseAuthor('Week 02 — Supplemental — Norris — Digital Divide — Complete book').author).toBe('Norris');
	});

	test('Mellamphy: printed page from the page foot, exact file line, verbatim text', () => {
		const doc = parseReading(MELLAMPHY, fs.readFileSync(MELLAMPHY, 'utf8'));
		expect(doc.author).toBe('Mellamphy');
		expect(doc.year).toBe('2021');
		const p = doc.passages.find(x => x.text.startsWith('Humans should never relinquish moral agency'))!;
		expect(p).toBeDefined();
		expect(p.line).toBe(136);
		expect(p.page).toBe('17');
		expect(p.pageKind).toBe('printed');
		expect(p.pdfPage).toBe(8);
		expect(fileLine(MELLAMPHY, p.line)).toContain(p.text);
	});

	test('Mellamphy: unmarked even pages are counted from the printed offset and tagged', () => {
		const doc = parseReading(MELLAMPHY, fs.readFileSync(MELLAMPHY, 'utf8'));
		const onPdf11 = doc.passages.filter(x => x.pdfPage === 11);
		expect(onPdf11.length).toBeGreaterThan(0);
		expect(onPdf11.every(x => x.page === '20' && x.pageKind === 'inferred')).toBe(true);
	});

	test('Carlson: running heads such as "418   MATT CARLSON" give printed pages', () => {
		const doc = parseReading(CARLSON, fs.readFileSync(CARLSON, 'utf8'));
		const page4 = doc.passages.filter(x => x.pdfPage === 4);
		expect(page4[0].page).toBe('418');
		expect(page4[0].pageKind).toBe('printed');
		expect(doc.passages.some(x => x.page === '424')).toBe(true);
	});

	test('readings without printed numbers fall back to a labelled PDF position', () => {
		const doc = parseReading('/tmp/x.md', '# Doe, Jane. "A test." (2020)\n\n## PDF page 3\n\nThis passage carries no printed page number anywhere on the page at all.\n');
		expect(doc.passages[0].page).toBe('PDF 3');
		expect(doc.passages[0].pageKind).toBe('pdf');
	});

	test('plain markdown readings pick up [p. N] markers', () => {
		const doc = parseReading('/tmp/plain.md', '# Roe 2019\n\n[p. 12]\n\nA plain reading paragraph long enough to be indexed as a passage of text.\n');
		expect(doc.passages[0]).toMatchObject({ page: '12', pageKind: 'printed', line: 5 });
	});

	test('the stemmer and tokenizer treat answers and readings alike', () => {
		expect(stem('controls')).toBe(stem('control'));
		expect(stem('governing')).toBe(stem('governed'));
		expect(tokenize('human-in-the-loop').map(t => t.surface)).toEqual(['human', 'loop']);
		expect(tokenize('alter- native').map(t => t.surface)).toEqual(['alternative']);
	});

	test('indexes the whole library and skips Archive duplicates', () => {
		expect(library.docs.length).toBeGreaterThan(100);
		expect(library.size).toBeGreaterThan(50_000);
		expect(library.docs.some(d => d.filePath.includes('/Archive/'))).toBe(false);
	});

	test('matchBookmarks ties a raw answer to concrete passages with a plain reason', () => {
		const raw = answer('keeping a human in the loop is mostly a comfort story, the human just rubber stamps whatever the machine decides and nobody has real control over the AI system');
		const bookmarks = library.matchBookmarks([raw], 6);
		expect(bookmarks.length).toBe(6);
		expect(bookmarks.some(b => b.author === 'Mellamphy')).toBe(true);
		for (const b of bookmarks) {
			expect(fileLine(b.filePath, b.line)).toContain(b.excerpt);
			expect(b.reason).toContain('Walk through how it happens');
			expect(analyzeDocument(b.reason)).toEqual([]);
		}
		const scores = bookmarks.map(b => b.score);
		expect([...scores].sort((a, b) => b - a)).toEqual(scores);
		const authors = bookmarks.map(b => b.author + b.year);
		for (const a of new Set(authors)) {
			expect(authors.filter(x => x === a).length).toBeLessThanOrEqual(2);
		}
	});

	test('matchBookmarks quotes the writer verbatim when a phrase is shared', () => {
		const raw = answer('the human in the loop is a fig leaf for whoever deploys the system');
		const withPhrase = library.matchBookmarks([raw]).find(b => b.reason.startsWith('You wrote'));
		expect(withPhrase?.reason).toContain('"human in the loop"');
	});

	test('matchBookmarks returns nothing without answers or readings', () => {
		expect(library.matchBookmarks([])).toEqual([]);
		expect(new ReadingsIndex().matchBookmarks([answer('anything at all here')])).toEqual([]);
	});

	test('containsQuote survives curly quotes, OCR hyphenation and ellipses', () => {
		expect(library.containsQuote('Humans should never relinquish moral agency to machines')).toBe(true);
		expect(library.containsQuote('approach from other alternative ethical approaches such as (Habermasian) communicative ethics')).toBe(true);
		expect(library.containsQuote('Humans should never relinquish moral agency ... machines should be "aligned" with human values')).toBe(true);
		expect(library.containsQuote('Humans should always hand moral agency over to the machines')).toBe(false);
	});
});

// ---------------------------------------------------------------------------

describe('citationNav', () => {
	test('parses single, grouped and ranged Author-Date citations with offsets', () => {
		const line = 'As argued (Mellamphy 2021: 20; Carlson 2015: 424-26) and (see Hansen and Nissenbaum 2009: 1160).';
		const cites = parseCitations(line);
		expect(cites.map(c => [c.surname, c.year, c.pageStart, c.pageEnd])).toEqual([
			['Mellamphy', '2021', 20, 20],
			['Carlson', '2015', 424, 426],
			['Hansen', '2009', 1160, 1160],
		]);
		for (const c of cites) {
			expect(line.slice(c.start, c.end)).toBe(c.text);
		}
		expect(citationAt(line, line.indexOf('Carlson') + 2)?.surname).toBe('Carlson');
		expect(citationAt(line, 2)).toBeNull();
		expect(parseCitations('(2021) and (see above)')).toEqual([]);
	});

	test('(Mellamphy 2021: 20) resolves to PDF page 11 of R022', () => {
		const [c] = parseCitations('(Mellamphy 2021: 20)');
		const r = resolveCitation(library, c)!;
		expect(r.doc.filePath).toBe(MELLAMPHY);
		expect(r.passages.length).toBeGreaterThan(0);
		expect(r.passages.every(p => p.pdfPage === 11)).toBe(true);
		expect(r.passages[0].line).toBeGreaterThan(170);
		expect(r.passages[0].line).toBeLessThan(184);
		expect(r.notes.join(' ')).toContain('counted from the nearest printed page');
	});

	test('(Carlson 2015: 424) finds the page and flags the edition year', () => {
		const [c] = parseCitations('(Carlson 2015: 424)');
		const r = resolveCitation(library, c)!;
		expect(r.doc.filePath).toBe(CARLSON);
		expect(r.passages[0].line).toBe(185);
		expect(r.passages[0].printedPage).toBe(424);
		expect(r.notes.join(' ')).toContain('dated 2018');
	});

	test('unknown authors and missing pages are reported plainly', () => {
		const [unknown] = parseCitations('(Nobodyknown 2020: 3)');
		expect(resolveCitation(library, unknown)).toBeNull();
		const [far] = parseCitations('(Mellamphy 2021: 300)');
		expect(resolveCitation(library, far)!.notes.join(' ')).toContain('outside the pages');
	});

	test('hover markdown shows the passage and a file link to the line', () => {
		const [c] = parseCitations('(Carlson 2015: 424)');
		const md = formatHover(c, resolveCitation(library, c), p => `file://${p.filePath}#L${p.line}`);
		expect(md).toContain('**Carlson 2018, p\\. 424**');
		expect(md).toContain(`#L185)`);
		expect(md).toContain('> ');
	});
});

// ---------------------------------------------------------------------------

describe('slopLinter', () => {
	const codes = (text: string, readings?: ReadingsIndex) => analyzeDocument(text, readings).map(d => d.code);

	test('flags negative parallelisms', () => {
		expect(codes('This is not merely a rule.')).toEqual(['negative-parallelism']);
		expect(codes('The ban is not simply about speech.')).toEqual(['negative-parallelism']);
		expect(codes('It was not a mistake, but a choice.')).toEqual(['negative-parallelism']);
		expect(codes('Rather than fixing it, they hid it.')).toEqual(['negative-parallelism']);
		expect(codes("It's not about money, it's about control.")).toContain('negative-parallelism');
		expect(codes('Speed is not the issue. Scale is the issue.')).toEqual(['negative-parallelism']);
	});

	test('flags hedge verbs, dashes and banned vocabulary', () => {
		expect(codes('The data suggests a link.')).toEqual(['hedge-verb']);
		expect(codes('Her view aligns with his.')).toEqual(['hedge-verb']);
		expect(codes('The state — and its police — act.')).toEqual(['em-dash', 'em-dash']);
		expect(codes('The state -- and its police -- act.')).toEqual(['em-dash', 'em-dash']);
		expect(codes('We delve into a rich tapestry of robust paradigms.')).toEqual(['ai-vocabulary', 'ai-vocabulary', 'ai-vocabulary', 'ai-vocabulary']);
		const [d] = analyzeDocument('They navigated the rules.');
		expect(d).toMatchObject({ line: 1, col: 6, code: 'ai-vocabulary', severity: 'warning', excerpt: 'navigated' });
		expect(d.message).toContain('Name what the person actually does');
	});

	test('em-dash findings carry the words around the dash', () => {
		const ds = analyzeDocument('In the long history of platform governance, the appeal button — a late addition — rarely changes the outcome.');
		expect(ds.map(d => d.excerpt)).toEqual([
			'...the appeal button — a late addition — rarely...',
			'...— a late addition — rarely changes the...',
		]);
		expect(analyzeDocument('Short — line.')[0].excerpt).toBe('Short — line.');
	});

	test('flags prose semicolons but allows them inside parenthetical citations', () => {
		expect(codes('The rule failed; nobody noticed.')).toEqual(['semicolon']);
		expect(codes('Both say so (Mellamphy 2021: 20; Carlson 2015: 424).')).toEqual([]);
		expect(codes('Fish &amp; chips.')).toEqual([]);
	});

	test('flags wide page ranges in Author-Date citations', () => {
		expect(codes('Humans stay in charge (Mellamphy 2021: 11-27).')).toEqual(['wide-page-range']);
		expect(codes('Humans stay in charge (Mellamphy 2021: 20-22).')).toEqual([]);
	});

	test('checks quotations against loaded readings only', () => {
		const real = 'She writes "Humans should never relinquish moral agency to machines" and moves on.';
		const fake = 'She writes "Humans should always hand moral agency over to machines" and moves on.';
		expect(codes(real, library)).toEqual([]);
		expect(codes(fake, library)).toEqual(['unverified-quote']);
		expect(codes(fake)).toEqual([]);
		expect(codes('She calls it "short".', library)).toEqual([]);
	});

	test('leaves code, front matter, rules, tables, block quotes and quoted wording alone', () => {
		const text = [
			'---',
			'title: a; b — c',
			'---',
			'```',
			'delve; robust -- x',
			'```',
			'Use `delve;` in code.',
			'---',
			'| a | b |',
			'| --- | --- |',
			'> A source may delve into a robust landscape; that is its wording.',
			'He called it "a robust and pivotal paradigm" in the interview.',
			'See [link](https://example.com/a;b--c).',
		].join('\n');
		expect(analyzeDocument(text)).toEqual([]);
	});

	test('reports self-commentary tails and abstract recasting at info level', () => {
		const ds = analyzeDocument('The platform bans him, and that is what bothers me.\nThe joke becomes the insult.');
		expect(ds.map(d => [d.code, d.severity, d.line])).toEqual([
			['self-commentary', 'info', 1],
			['abstract-recasting', 'info', 2],
		]);
	});

	test('clean prose produces no findings', () => {
		const text = 'Meta fired the moderators in May, and the reports piled up. The appeal gives people a way to challenge a false ban (Gorwa 2019: 860).';
		expect(analyzeDocument(text)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------

describe('workflowStore', () => {
	const made: string[] = [];
	const tmp = () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-studio-'));
		made.push(dir);
		return dir;
	};
	afterAll(() => made.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

	test('init creates the three files once and never overwrites them', () => {
		const dir = tmp();
		const store = new WorkflowStore(dir);
		expect(store.isReady()).toBe(false);
		expect(store.init().sort()).toEqual(['interview-state.md', 'raw-answers.md', 'source-map.md']);
		expect(store.isReady()).toBe(true);
		fs.writeFileSync(store.file('interview-state.md'), 'my own notes');
		expect(store.init()).toEqual([]);
		expect(fs.readFileSync(store.file('interview-state.md'), 'utf8')).toBe('my own notes');
	});

	test('appendAnswer only appends and round-trips text verbatim', () => {
		const store = new WorkflowStore(tmp());
		store.init();
		const first = store.appendAnswer(QUESTIONS[0], 'the platform is the regulator now, honestly');
		const before = fs.readFileSync(store.file('raw-answers.md'), 'utf8');
		const tricky = 'line one\n\n### not a header of ours\nQuestion: also not ours\n\ntrailing newline\n';
		const second = store.appendAnswer(QUESTIONS[1], tricky);
		const after = fs.readFileSync(store.file('raw-answers.md'), 'utf8');
		expect(after.startsWith(before)).toBe(true);
		const answers = store.readAnswers();
		expect(answers.map(a => a.id)).toEqual([first.id, second.id]);
		expect(answers[0].text).toBe('the platform is the regulator now, honestly');
		expect(answers[1].text).toBe(tricky);
		expect(answers[1].prompt).toBe(QUESTIONS[1]);
		expect(parseRawAnswers(after)).toEqual(answers);
	});

	test('pickQuestion skips answered questions and cycles from the cursor', () => {
		expect(pickQuestion([], 0)).toBe(QUESTIONS[0]);
		expect(pickQuestion([answer('x y z', QUESTIONS[0])], 0)).toBe(QUESTIONS[1]);
		expect(pickQuestion([], 3)).toBe(QUESTIONS[3]);
		expect(pickQuestion(QUESTIONS.map(q => answer('x y z', q)), 12)).toBe(QUESTIONS[2]);
	});

	test('questions stay concrete and pass the linter', () => {
		for (const q of QUESTIONS) {
			expect(q).toMatch(/[?.]$/);
			expect(q.length).toBeLessThan(140);
			expect(analyzeDocument(q)).toEqual([]);
		}
	});

	test('coaxing starters quote the writer exactly, cite a bookmark and stay deterministic', () => {
		const raw = answer('The appeal button is theater. Meta reversed my ban after a human finally looked at it.', QUESTIONS[0], 'ans-7');
		const bookmark: Bookmark = { id: 'b', author: 'Gorwa', year: '2019', page: '860', filePath: '/x', line: 1, excerpt: 'Platform appeal processes let a human review a ban', reason: '', score: 1 };
		const coax = buildCoaxingStarters([raw], [bookmark]);
		expect(coax.basedOnAnswerId).toBe('ans-7');
		expect(coax.starters.length).toBe(2);
		expect(coax.starters[0]).toContain('"The appeal button is theater"');
		expect(coax.starters[1]).toContain('Gorwa (2019: 860)');
		expect(coax.starters[1]).toContain('"Meta reversed my ban after a human finally looked at it"');
		expect(buildCoaxingStarters([raw], [bookmark])).toEqual(coax);
		for (const s of coax.starters) {
			expect(analyzeDocument(s)).toEqual([]);
		}
	});

	test('coaxing rotates through answers and handles an empty bank', () => {
		const a = answer('First answer has some words.', QUESTIONS[0], 'a');
		const b = answer('Second answer has other words.', QUESTIONS[1], 'b');
		expect(buildCoaxingStarters([a, b], []).basedOnAnswerId).toBe('b');
		expect(buildCoaxingStarters([a, b], [], 1).basedOnAnswerId).toBe('a');
		expect(buildCoaxingStarters([], [])).toMatchObject({ starters: [], basedOnAnswerId: null });
	});
});
