// v0.2 units: argument outline, paragraph lenses, quick fixes, skeletons and
// question context. Quote snapping runs against the real Knowledge Library.

import { beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import type { ParagraphOutlineNode, RawAnswer } from '../src/shared/protocol';
import { analyzeOutline, ArgumentOutlineTreeProvider, distinctSources, paragraphAtLine, quoteCount, splitParagraphs } from '../src/core/argumentOutline';
import { actionFor, buildParagraphLenses, createParagraphLensProvider, matchReadingForParagraph, statusTitle } from '../src/core/paragraphLens';
import { createQuickFixProvider, FixEdit, fixesFor, snapQuote } from '../src/core/quickFixes';
import { ReadingsIndex } from '../src/core/readingsIndex';
import { getSkeletonText, planSkeletonInsert, SKELETON_OPTIONS } from '../src/core/skeletons';
import { analyzeDocument } from '../src/core/slopLinter';
import { buildQuestionContext, CURATED_QUESTIONS, optionsFor, QUESTIONS } from '../src/core/workflowStore';

const LIBRARY = '/Users/admin/Documents/obsidian/school/2026-2027/POLISCI 3390F/Knowledge Library';
const MELLAMPHY = path.join(LIBRARY, 'Week 03/R022.md');
const CARLSON = path.join(LIBRARY, 'Week 04/R031.md');
const fileLine = (file: string, line: number) => fs.readFileSync(file, 'utf8').split(/\r?\n/)[line - 1];
const answer = (text: string, id = 'a1', prompt = QUESTIONS[0]): RawAnswer => ({ id, timestamp: '2026-11-23T12:00:00.000Z', prompt, text });

let library: ReadingsIndex;
beforeAll(async () => {
	library = await ReadingsIndex.build([LIBRARY]);
}, 60_000);

// Applies single-line edits right to left so earlier columns stay valid.
function apply(text: string, edits: FixEdit[]): string {
	const lines = text.split('\n');
	for (const e of [...edits].sort((a, b) => b.line - a.line || b.start - a.start)) {
		lines[e.line] = lines[e.line].slice(0, e.start) + e.text + lines[e.line].slice(e.end);
	}
	return lines.join('\n');
}

// Runs the linter, then the quick fix for the first finding with `code`.
function fixFirst(text: string, code: string, readings: ReadingsIndex | null = null) {
	const f = analyzeDocument(text, readings).find(d => d.code === code);
	if (!f) {
		throw new Error(`no ${code} finding in: ${text}`);
	}
	const lineText = text.split('\n')[f.line - 1];
	return fixesFor(code, lineText, f.line - 1, f.col - 1, f.col - 1 + f.length, readings);
}

// A healthy body paragraph: three sources, three quotes, a counter-move, ~120 words.
const HEALTHY = [
	'Keeping a person in the loop changes who answers for a decision more than who makes it.',
	'Mellamphy warns that "Humans should never relinquish moral agency to machines" (Mellamphy 2021: 17),',
	'and Carlson notes that "the long-running trope of human versus machine is now complicated" (Carlson 2015: 424).',
	'Suzor (2019: 12) adds that "platforms write rules they alone enforce" for millions of users.',
	'However, the reviewer often sees a case for seconds, so the signature means little.',
	'The appeal gives users a name to blame, and a name is easier to sue than a model.',
	'That shift explains why platforms keep the loop even when the human adds no judgment of their own',
	'and why regulators keep asking for it in each new draft of the rules they publish.',
].join('\n');

// ---------------------------------------------------------------------------

describe('argumentOutline', () => {
	const draft = [
		'---',
		'title: Draft; with — dashes',
		'---',
		'# Introduction',
		'',
		'Platforms keep humans in the loop to share blame.',
		'',
		'## The loop as liability shield',
		'',
		HEALTHY,
		'',
		'```',
		'code block "that should never count as a quote"',
		'```',
		'',
		'| a | b |',
		'| --- | --- |',
		'',
		'> A block quote "with a long quotation inside it" stays out.',
		'',
		'---',
		'',
		'The moderator checks a flagged post and clicks approve.',
		'',
		'# Conclusion',
		'',
		'So the loop protects the platform first.',
		'',
		'## References',
		'',
		'Mellamphy, Nandita. 2021. "Humans in the Loop." Nature and Culture.',
	].join('\n');

	test('splits prose paragraphs and skips front matter, code, tables, rules, block quotes and references', () => {
		const paras = splitParagraphs(draft);
		expect(paras.map(p => [p.line, p.heading])).toEqual([
			[6, 'Introduction'],
			[10, 'The loop as liability shield'],
			[30, 'The loop as liability shield'],
			[34, 'Conclusion'],
		]);
		expect(paras[1].text).toBe(HEALTHY);
	});

	test('counts words, distinct sources, quotes and counter-moves per paragraph', () => {
		const [intro, body, short, outro] = analyzeOutline(draft);
		expect(body).toMatchObject({ index: 2, line: 10, distinctSources: 3, quoteCount: 3, hasCounterMove: true, gaps: [] });
		expect(body.words).toBeGreaterThan(110);
		expect(body.preview.length).toBeLessThanOrEqual(75);
		expect(body.preview).toBe('Keeping a person in the loop changes who answers for a decision more...');
		expect(intro.hasCounterMove).toBe(false);
		expect(short).toMatchObject({ index: 3, distinctSources: 0, quoteCount: 0, gaps: ['0/3 sources', 'no direct quote', 'under 80 words'] });
		expect(outro.index).toBe(4);
	});

	test('introduction and conclusion paragraphs skip source and quote gaps', () => {
		const [intro, , , outro] = analyzeOutline(draft);
		expect(intro.gaps).toEqual(['under 80 words']);
		expect(outro.gaps).toEqual(['under 80 words']);
	});

	test('the opening heading defaults to "(Opening)" and long paragraphs are flagged', () => {
		const long = Array.from({ length: 260 }, (_, k) => `word${k}`).join(' ');
		const [n] = analyzeOutline(long);
		expect(n.heading).toBe('(Opening)');
		expect(n.gaps).toContain('over 250 words, consider splitting');
	});

	test('dedupes sources across parenthetical, grouped and narrative citations', () => {
		expect(distinctSources('As shown (Mellamphy 2021: 20; Carlson 2015: 424) and Mellamphy (2021: 17) again (Carlson 2015).')).toBe(2);
		expect(distinctSources('Gorwa (2019) and Suzor et al. (2019: 3) disagree.')).toBe(2);
		expect(distinctSources('No sources here (see above).')).toBe(0);
	});

	test('quotes count only at 15 characters or more, straight or curly', () => {
		expect(quoteCount('He said "short" and “this one is long enough to count” and "another long quoted phrase".')).toBe(2);
	});

	test('links raw answers that share content words with a paragraph', () => {
		const answers = [
			answer('the reviewer only sees the case for seconds so the signature means nothing', 'match'),
			answer('my cat prefers the sunny porch', 'nope'),
		];
		const body = analyzeOutline(draft, answers)[1];
		expect(body.matchedAnswerIds).toEqual(['match']);
	});

	test('a draft with no counter-move anywhere is told so once', () => {
		const flat = ['A claim.', 'B claim.', 'C claim.', 'D claim.'].join('\n\n');
		const nodes = analyzeOutline(flat);
		expect(nodes.filter(n => n.gaps.includes('no caveat or objection in the draft yet')).map(n => n.index)).toEqual([4]);
		expect(analyzeOutline(flat.replace('C claim.', 'Yet C claim.')).some(n => n.gaps.some(g => g.includes('caveat')))).toBe(false);
	});

	test('paragraphAtLine finds the paragraph holding a line', () => {
		const nodes = analyzeOutline(draft);
		expect(paragraphAtLine(nodes, 12)?.index).toBe(2);
		expect(paragraphAtLine(nodes, 2)).toBeNull();
	});

	test('the tree view groups paragraphs by heading and jumps on click', () => {
		const fake = fakeVscode();
		const tree = new ArgumentOutlineTreeProvider(fake as any);
		let fired = 0;
		tree.onDidChangeTreeData(() => fired++);
		const uri = { fsPath: '/d.md' };
		tree.update(analyzeOutline(draft), uri as any);
		expect(fired).toBe(1);
		const roots = tree.getChildren();
		expect(roots.map(r => (r.kind === 'heading' ? r.heading : ''))).toEqual(['Introduction', 'The loop as liability shield', 'Conclusion']);
		const kids = tree.getChildren(roots[1]);
		expect(kids.length).toBe(2);
		const item = tree.getTreeItem(kids[0]) as any;
		expect(item.label).toStartWith('P2  Keeping a person');
		expect(item.description).toContain('3 src · 3 quotes');
		expect(item.command).toEqual({ command: 'writerStudio.jumpToLine', title: 'Go to paragraph', arguments: [10, uri] });
		expect(item.iconPath.id).toBe('pass');
		const gapItem = tree.getTreeItem(kids[1]) as any;
		expect(gapItem.description).toContain('0/3 sources · no direct quote');
		expect(gapItem.iconPath.id).toBe('circle-outline');
		expect((tree.getTreeItem(roots[1]) as any).collapsibleState).toBe(fake.TreeItemCollapsibleState.Expanded);

		tree.update(analyzeOutline('One.\n\nTwo.'), uri as any);
		expect(tree.getChildren().every(r => r.kind === 'paragraph')).toBe(true);
	});
});

// ---------------------------------------------------------------------------

describe('paragraphLens', () => {
	const node = (over: Partial<ParagraphOutlineNode>): ParagraphOutlineNode => ({
		index: 1, line: 1, heading: '(Opening)', preview: '', words: 120, distinctSources: 3, quoteCount: 2,
		hasCounterMove: true, gaps: [], matchedAnswerIds: [], ...over,
	});

	test('status lens reads like the examples', () => {
		expect(statusTitle(node({ words: 54, distinctSources: 1, quoteCount: 0 }))).toBe('54 words · 1/3 sources · 0 quotes');
		expect(statusTitle(node({ words: 190, distinctSources: 3, quoteCount: 3 }))).toBe('190 words · 3/3 sources · 3 quotes');
		expect(statusTitle(node({ words: 1, quoteCount: 1 }))).toBe('1 word · 3/3 sources · 1 quote');
	});

	test('one action lens: reading for evidence gaps, skeleton for short paragraphs, none when healthy', () => {
		expect(actionFor(node({}), true)).toBeNull();
		expect(actionFor(node({ words: 120, gaps: ['1/3 sources'] }), true)?.title).toBe('Open matching reading');
		expect(actionFor(node({ words: 120, gaps: ['1/3 sources'] }), false)?.title).toBe('Insert paragraph skeleton');
		expect(actionFor(node({ words: 20, gaps: ['0/3 sources', 'under 80 words'] }), true)?.title).toBe('Insert paragraph skeleton');
		expect(actionFor(node({ words: 120, gaps: ['no caveat or objection in the draft yet'] }), true)?.title).toBe('Insert paragraph skeleton');
	});

	test('buildParagraphLenses passes the document and line to each command', () => {
		const outline = analyzeOutline(`${HEALTHY}\n\nA short line with no support.`);
		const lenses = buildParagraphLenses(outline, true, 'URI');
		expect(lenses.map(l => [l.line, l.title, l.command])).toEqual([
			[1, statusTitle(outline[0]), 'writerStudio.openPanel'],
			[10, '6 words · 0/3 sources · 0 quotes', 'writerStudio.openPanel'],
			[10, 'Insert paragraph skeleton', 'writerStudio.insertSkeleton'],
		]);
		expect(lenses[2].args).toEqual([undefined, 'URI', 10]);
	});

	test('the provider renders real CodeLenses and honours the setting', () => {
		const fake = fakeVscode();
		let enabled = true;
		const provider = createParagraphLensProvider(fake as any, () => [], () => library, () => enabled, () => true);
		const doc = { getText: () => 'The moderator checks a flagged post and approves it within seconds, every time, all day long.', uri: 'U' };
		const lenses = provider.provideCodeLenses(doc as any, {} as any) as any[];
		expect(lenses.map(l => l.command.title)).toEqual(['16 words · 0/3 sources · 0 quotes', 'Insert paragraph skeleton']);
		expect(lenses[0].range).toMatchObject({ startLine: 0 });
		let refreshed = 0;
		provider.onDidChangeCodeLenses!(() => refreshed++);
		enabled = false;
		provider.refresh();
		expect(refreshed).toBe(1);
		expect(provider.provideCodeLenses(doc as any, {} as any)).toEqual([]);
	});

	test('matchReadingForParagraph opens the passage closest to the paragraph', () => {
		const b = matchReadingForParagraph(library, 'Humans should keep moral agency and never hand it to machines, even when the machine is aligned with human values.');
		expect(b?.author).toBe('Mellamphy');
		expect(fileLine(b!.filePath, b!.line)).toContain(b!.excerpt);
		expect(matchReadingForParagraph(null, 'anything')).toBeNull();
	});
});

// ---------------------------------------------------------------------------

describe('quickFixes', () => {
	test('snaps a slightly misquoted Mellamphy line to the exact local reading', () => {
		const text = 'Mellamphy insists that "Humans should never give up moral agency to machines" (Mellamphy 2021: 17).';
		const [fix] = fixFirst(text, 'unverified-quote', library);
		expect(fix.title).toBe('Snap to verified quote (Mellamphy 2021: p. 17)');
		expect(fix.preferred).toBe(true);
		const fixed = apply(text, fix.edits);
		expect(fixed).toBe('Mellamphy insists that "Humans should never relinquish moral agency to machines" (Mellamphy 2021: 17).');
		expect(fileLine(MELLAMPHY, 136)).toContain(fix.edits[0].text);
		expect(analyzeDocument(fixed, library).map(d => d.code)).toEqual([]);
	});

	test('snaps a misquoted Carlson sentence and rejoins the OCR hyphen', () => {
		const text = 'Carlson writes that “the long running trope of humans versus machines is now complicated by advances in artificial intelligence” (Carlson 2015: 424).';
		const [fix] = fixFirst(text, 'unverified-quote', library);
		expect(fix.title).toBe('Snap to verified quote (Carlson 2018: p. 424)');
		expect(fix.edits[0].text).toBe('The long-running trope of human versus machine is now complicated by developments in artificial intelligence');
		expect(fileLine(CARLSON, 185)).toContain(fix.edits[0].text);
		expect(analyzeDocument(apply(text, fix.edits), library).some(d => d.code === 'unverified-quote')).toBe(false);
	});

	test('does not snap a quote whose meaning is reversed or that no reading holds', () => {
		expect(snapQuote(library, 'Humans should always hand moral agency over to the machines')).toBeNull();
		expect(snapQuote(library, 'my cat enjoys sunny afternoons on the porch near the garden')).toBeNull();
		expect(snapQuote(null, 'Humans should never give up moral agency to machines')).toBeNull();
		expect(fixFirst('She writes "Humans should always hand moral agency over to machines" here.', 'unverified-quote', library)).toEqual([]);
	});

	test('wide page ranges: pinpoint the starting page or open the reading', () => {
		const text = 'Humans stay in charge (Mellamphy 2021: 11-27).';
		const [pin, open] = fixFirst(text, 'wide-page-range', library);
		expect(pin.title).toBe('Pinpoint starting page (Mellamphy 2021: 11)');
		expect(apply(text, pin.edits)).toBe('Humans stay in charge (Mellamphy 2021: 11).');
		expect(open.title).toBe('Open reading to check page');
		expect(open.edits).toEqual([]);
		expect(open.command).toMatchObject({ command: 'writerStudio.openReadingBeside', arguments: [MELLAMPHY, expect.any(Number)] });
		// The spec's alias and the pp. form.
		const pp = 'See (Carlson 2015: pp. 418-430).';
		const f = analyzeDocument(pp).find(d => d.code === 'wide-page-range')!;
		const [pinPp] = fixesFor('wide-range', pp, 0, f.col - 1, f.col - 1 + f.length, null);
		expect(apply(pp, pinPp.edits)).toBe('See (Carlson 2015: p. 418).');
	});

	test('em dash: replace with a comma or split the sentence', () => {
		const text = 'The appeal is theater — nobody reads it.';
		const [comma, split] = fixFirst(text, 'em-dash');
		expect([comma.title, split.title]).toEqual(['Replace em dash with comma', 'Split into two sentences']);
		expect(apply(text, comma.edits)).toBe('The appeal is theater, nobody reads it.');
		expect(apply(text, split.edits)).toBe('The appeal is theater. Nobody reads it.');
		expect(apply('Fast--cheap.', fixesFor('em-dash', 'Fast--cheap.', 0, 4, 6, null)[0].edits)).toBe('Fast, cheap.');
	});

	test('hedge verbs become a committed verb in the same form and case', () => {
		const text = 'The data suggests a link.';
		const [shows, argues] = fixFirst(text, 'hedge-verb');
		expect([shows.title, argues.title]).toEqual(['Replace with "shows"', 'Replace with "argues"']);
		expect(apply(text, shows.edits)).toBe('The data shows a link.');
		expect(apply(text, argues.edits)).toBe('The data argues a link.');
		expect(apply('Suggesting ties.', fixFirst('Suggesting ties.', 'hedge-verb')[0].edits)).toBe('Showing ties.');
		const align = fixFirst('Her view aligns with his.', 'hedge-verb');
		expect(align.map(f => apply('Her view aligns with his.', f.edits))).toEqual(['Her view agrees with his.', 'Her view supports his.']);
	});

	test('semicolons: a period, or a comma that keeps the sentence grammatical', () => {
		const text = 'The rule failed; nobody noticed.';
		const [period, comma] = fixFirst(text, 'semicolon');
		expect(period.title).toBe('Replace semicolon with period');
		expect(apply(text, period.edits)).toBe('The rule failed. Nobody noticed.');
		expect(comma.title).toBe('Replace semicolon with comma and "and"');
		expect(apply(text, comma.edits)).toBe('The rule failed, and nobody noticed.');
		const but = 'It passed; but nobody read it.';
		const fixes = fixesFor('prose-semicolon', but, 0, but.indexOf(';'), but.indexOf(';') + 1, null);
		expect(fixes[1].title).toBe('Replace semicolon with comma');
		expect(apply(but, fixes[1].edits)).toBe('It passed, but nobody read it.');
	});

	test('every applied fix clears its own finding', () => {
		const cases: Array<[string, string]> = [
			['The appeal is theater — nobody reads it.', 'em-dash'],
			['The data suggests a link.', 'hedge-verb'],
			['The rule failed; nobody noticed.', 'semicolon'],
			['Humans stay in charge (Mellamphy 2021: 11-27).', 'wide-page-range'],
		];
		for (const [text, code] of cases) {
			for (const fix of fixFirst(text, code, library).filter(f => f.edits.length)) {
				expect(analyzeDocument(apply(text, fix.edits)).some(d => d.code === code)).toBe(false);
			}
		}
		expect(fixesFor('ai-vocabulary', 'They leverage it.', 0, 5, 13, null)).toEqual([]);
	});

	test('the CodeActionProvider turns Writer diagnostics into QuickFix actions', () => {
		const fake = fakeVscode();
		const provider = createQuickFixProvider(fake as any, () => library);
		const text = 'Mellamphy insists that "Humans should never give up moral agency to machines" here; really.';
		const doc = { uri: 'U', lineAt: () => ({ text }) };
		const diag = (code: unknown, from: number, to: number, source = 'Writer') => ({ code, source, range: new fake.Range(0, from, 0, to) });
		const q = text.indexOf('"');
		const actions = provider.provideCodeActions(doc as any, {} as any, {
			diagnostics: [
				diag('unverified-quote', q, text.indexOf('"', q + 1) + 1),
				diag({ value: 'semicolon', target: 'x' }, text.indexOf(';'), text.indexOf(';') + 1),
				diag('semicolon', 0, 1, 'markdownlint'),
			],
		} as any, {} as any) as any[];
		expect(actions.map(a => [a.title, a.kind])).toEqual([
			['Snap to verified quote (Mellamphy 2021: p. 17)', 'quickfix'],
			['Replace semicolon with period', 'quickfix'],
			['Replace semicolon with comma and "and"', 'quickfix'],
		]);
		expect(actions[0].isPreferred).toBe(true);
		expect(actions[0].edit.replacements[0]).toMatchObject({ uri: 'U', text: 'Humans should never relinquish moral agency to machines' });
		expect(actions[0].diagnostics[0].code).toBe('unverified-quote');
	});
});

// ---------------------------------------------------------------------------

describe('skeletons', () => {
	test('offers the three structural templates by id', () => {
		expect(SKELETON_OPTIONS.map(o => o.id)).toEqual(['body-triangulate', 'caveat-tradeoff', 'synthesis-bridge']);
		expect(SKELETON_OPTIONS[0].label).toBe('Body paragraph (3 sources)');
		expect(getSkeletonText('nope')).toBeNull();
	});

	test('templates hold labelled slots only and pass the linter', () => {
		const body = getSkeletonText('body-triangulate')!;
		expect(body.split('\n').map(l => l.slice(0, l.indexOf(':') + 1))).toEqual(['[Claim:', '[Source 1:', '[Source 2:', '[Source 3:', '[Bridge:']);
		expect(getSkeletonText('caveat-tradeoff')!.split('\n').length).toBe(3);
		for (const o of SKELETON_OPTIONS) {
			const text = getSkeletonText(o.id)!;
			expect(text.split('\n').every(l => /^\[[^\]]+\]$/.test(l))).toBe(true);
			expect(analyzeDocument(text)).toEqual([]);
			expect(analyzeDocument(o.label + '. ' + o.description)).toEqual([]);
		}
	});

	test('an inserted skeleton is one outline paragraph with slots to fill', () => {
		const [n] = analyzeOutline(getSkeletonText('body-triangulate')!);
		expect(n).toMatchObject({ words: 0, distinctSources: 0, quoteCount: 0, preview: '(empty skeleton)' });
		expect(n.gaps[0]).toBe('5 slots to fill');
		const half = getSkeletonText('body-triangulate')!.replace('[Claim: one sentence, in your own words, that this paragraph proves.]', 'The loop shifts blame.');
		const [m] = analyzeOutline(half);
		expect(m.words).toBe(4);
		expect(m.gaps[0]).toBe('4 slots to fill');
	});

	test('planSkeletonInsert keeps blank lines around the skeleton', () => {
		const S = 'S1\nS2';
		const insert = (lines: string[], cursor: number) => {
			const p = planSkeletonInsert(lines, cursor, S);
			const out = apply(lines.join('\n'), [{ line: p.line, start: p.character, end: p.character, text: p.text }]);
			return { out, first: out.split('\n')[p.firstSlotLine] };
		};
		expect(insert(['A', '', 'B'], 1)).toEqual({ out: 'A\n\nS1\nS2\n\nB', first: 'S1' });
		expect(insert(['A', 'a2', '', 'B'], 0)).toEqual({ out: 'A\na2\n\nS1\nS2\n\nB', first: 'S1' });
		expect(insert(['A', 'a2'], 1)).toEqual({ out: 'A\na2\n\nS1\nS2', first: 'S1' });
		expect(insert([''], 0)).toEqual({ out: 'S1\nS2\n', first: 'S1' });
		expect(insert(['', 'B'], 0)).toEqual({ out: 'S1\nS2\n\nB', first: 'S1' });
	});
});

// ---------------------------------------------------------------------------

describe('questionContext', () => {
	test('every curated question carries 2-3 short, distinct, lint-clean stance options', () => {
		expect(CURATED_QUESTIONS.map(q => q.question)).toEqual(QUESTIONS);
		for (const { question, options } of CURATED_QUESTIONS) {
			expect(options.length).toBeGreaterThanOrEqual(2);
			expect(options.length).toBeLessThanOrEqual(3);
			expect(new Set(options.map(o => o.label)).size).toBe(options.length);
			for (const o of options) {
				const words = o.label.split(/\s+/).length;
				expect(words).toBeGreaterThanOrEqual(3);
				expect(words).toBeLessThanOrEqual(6);
				expect(o.label).toMatch(/^\p{Lu}[^.?!]*$/u);
				// A seed is an opening clause the writer must finish.
				expect(o.seed).toMatch(/ $/);
				expect(o.seed).not.toMatch(/[.?!] $/);
				expect(analyzeDocument(o.label)).toEqual([]);
				expect(analyzeDocument(o.seed + 'x.')).toEqual([]);
			}
			expect(optionsFor(question)).toBe(options);
		}
		expect(optionsFor('a question nobody curated')).toEqual([]);
	});

	test('features up to two verbatim excerpts matched to the writer\'s answers', () => {
		const answers = [answer('keeping a human in the loop is a comfort story, the human just rubber stamps what the machine decides and nobody has real control')];
		const ctx = buildQuestionContext(QUESTIONS[4], answers, library);
		expect(ctx.question).toBe(QUESTIONS[4]);
		expect(ctx.options).toBe(CURATED_QUESTIONS[4].options);
		expect(ctx.featuredBookmarks.length).toBe(2);
		expect(new Set(ctx.featuredBookmarks.map(b => b.author + b.year)).size).toBe(2);
		for (const b of ctx.featuredBookmarks) {
			expect(fileLine(b.filePath, b.line)).toContain(b.excerpt);
		}
		expect(buildQuestionContext(QUESTIONS[4], answers, library)).toEqual(ctx);
	});

	test('features nothing without answers or readings, and keeps the options', () => {
		expect(buildQuestionContext(QUESTIONS[0], [], library)).toEqual({ question: QUESTIONS[0], options: CURATED_QUESTIONS[0].options, featuredBookmarks: [] });
		expect(buildQuestionContext(QUESTIONS[0], [answer('some words about control')], null).featuredBookmarks).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Just enough of the vscode API for the providers.

function fakeVscode() {
	class Range { constructor(readonly startLine: number, readonly startCol: number, readonly endLine: number, readonly endCol: number) {} get start() { return { line: this.startLine, character: this.startCol }; } get end() { return { line: this.endLine, character: this.endCol }; } }
	class EventEmitter<T> {
		private listeners: Array<(e: T) => void> = [];
		event = (fn: (e: T) => void) => { this.listeners.push(fn); return { dispose() {} }; };
		fire(e: T) { this.listeners.forEach(fn => fn(e)); }
		dispose() {}
	}
	return {
		Range,
		EventEmitter,
		TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
		TreeItem: class { description?: string; tooltip?: string; iconPath?: unknown; command?: unknown; constructor(readonly label: string, readonly collapsibleState: number) {} },
		ThemeIcon: class { constructor(readonly id: string) {} },
		CodeLens: class { constructor(readonly range: Range, readonly command: unknown) {} },
		CodeActionKind: { QuickFix: 'quickfix' },
		CodeAction: class { diagnostics?: unknown[]; isPreferred?: boolean; edit?: unknown; command?: unknown; constructor(readonly title: string, readonly kind: string) {} },
		WorkspaceEdit: class { replacements: Array<{ uri: unknown; range: Range; text: string }> = []; replace(uri: unknown, range: Range, text: string) { this.replacements.push({ uri, range, text }); } },
	};
}
