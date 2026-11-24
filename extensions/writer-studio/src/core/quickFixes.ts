// One-click repairs for writer-lint findings. fixesFor() is pure and returns
// plain edit specs; registerQuickFixes() turns them into vscode CodeActions.
// The quotation snap only ever inserts wording copied from a local reading.

import type * as vscodeTypes from 'vscode';
import { parseCitations, resolveCitation } from './citationNav';
import { normalizeForMatch, tokenize, type Passage, type ReadingDoc, type ReadingsIndex } from './readingsIndex';

export interface FixEdit {
	line: number; // 0-based
	start: number; // 0-based columns, end exclusive
	end: number;
	text: string;
}

export interface FixSpec {
	title: string;
	edits: FixEdit[];
	command?: { command: string; title: string; arguments: unknown[] };
	preferred?: boolean;
}

// ---------------------------------------------------------------------------
// Quotation snapping

export interface QuoteSnap {
	text: string; // the reading's wording, ready to sit inside quotation marks
	passage: Passage;
	doc: ReadingDoc;
	similarity: number; // Dice coefficient over character trigrams, 0..1
}

export const SNAP_THRESHOLD = 0.72;
// Share of the quote's content words the window must contain. Trigram overlap
// alone accepts a fragment that shares one clause and drops the rest.
export const SNAP_COVERAGE = 0.7;
const CANDIDATE_PASSAGES = 40;
const WINDOW_SLACK = 3; // words either side of the quote's own length

function trigrams(s: string): Set<string> {
	const padded = ` ${s} `;
	const out = new Set<string>();
	for (let i = 0; i + 3 <= padded.length; i++) {
		out.add(padded.slice(i, i + 3));
	}
	return out;
}

function dice(a: Set<string>, b: Set<string>): number {
	let shared = 0;
	const [small, large] = a.size < b.size ? [a, b] : [b, a];
	for (const g of small) {
		if (large.has(g)) {
			shared++;
		}
	}
	return (2 * shared) / (a.size + b.size || 1);
}

// The verbatim window, tidied only where quotation form requires it: OCR
// line-break hyphens rejoined (as containsQuote does), quotation marks inside
// turned to single marks, and loose punctuation at the edges dropped.
function asQuotation(raw: string): string {
	return raw
		.replace(/(\p{L})-\s+(\p{L})/gu, '$1$2')
		.replace(/[“”]/g, m => (m === '“' ? '‘' : '’'))
		.replace(/"/g, "'")
		.replace(/^[^\p{L}\p{N}‘'(\[]+/u, '')
		.replace(/[\s,;:.—–-]+$/u, '')
		.trim();
}

export function snapQuote(index: ReadingsIndex | null, quote: string): QuoteSnap | null {
	const target = normalizeForMatch(quote);
	if (!index || target.length < 12) {
		return null;
	}
	const want = target.split(' ').length;
	const targetGrams = trigrams(target);
	const targetStems = new Set(tokenize(quote).map(t => t.stem));
	const needStems = Math.ceil(targetStems.size * SNAP_COVERAGE);
	let best: { passage: Passage; start: number; end: number; score: number } | null = null;

	for (const passage of index.searchPassages(quote, CANDIDATE_PASSAGES)) {
		const words = [...passage.text.matchAll(/\S+/g)].map(m => ({
			start: m.index!,
			end: m.index! + m[0].length,
			norm: normalizeForMatch(m[0]),
			stems: tokenize(m[0]).map(t => t.stem).filter(st => targetStems.has(st)),
		}));
		for (let s = 0; s < words.length; s++) {
			if (!words[s].norm) {
				continue;
			}
			let norm = '';
			let counted = 0;
			const covered = new Set<string>();
			for (let e = s; e < words.length && counted < want + WINDOW_SLACK; e++) {
				if (!words[e].norm) {
					continue;
				}
				norm = norm ? `${norm} ${words[e].norm}` : words[e].norm;
				counted += words[e].norm.split(' ').length;
				words[e].stems.forEach(st => covered.add(st));
				if (counted < Math.max(2, want - WINDOW_SLACK) || covered.size < needStems) {
					continue;
				}
				const score = dice(targetGrams, trigrams(norm));
				if (!best || score > best.score) {
					best = { passage, start: words[s].start, end: words[e].end, score };
				}
			}
		}
	}
	if (!best || best.score < SNAP_THRESHOLD) {
		return null;
	}
	const text = asQuotation(best.passage.text.slice(best.start, best.end));
	return text ? { text, passage: best.passage, doc: index.docOf(best.passage), similarity: Math.round(best.score * 1000) / 1000 } : null;
}

export function pageCite(doc: ReadingDoc, passage: Passage): string {
	const page = /^\d+$/.test(passage.page) ? `p. ${passage.page}` : passage.page;
	return page ? `${doc.author} ${doc.year}: ${page}` : `${doc.author} ${doc.year}`;
}

// ---------------------------------------------------------------------------
// Fixes per lint code

const CODE_ALIASES: Record<string, string> = { 'wide-range': 'wide-page-range', 'prose-semicolon': 'semicolon' };

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const matchCase = (model: string, word: string) => (/^\p{Lu}/u.test(model) ? capitalize(word) : word);

// The verbs a hedge is replaced with, by the hedge's form.
const HEDGE_SWAPS: Array<[RegExp, [string, string]]> = [
	[/^suggests$/i, ['shows', 'argues']],
	[/^suggesting$/i, ['showing', 'arguing']],
	[/^aligns with$/i, ['agrees with', 'supports']],
	[/^align with$/i, ['agree with', 'support']],
	[/^aligned with$/i, ['agreed with', 'supported']],
	[/^aligning with$/i, ['agreeing with', 'supporting']],
];

const CONJUNCTION = /^(?:and|but|so|or|yet|nor)\b/i;

// Replaces [start, end) plus the spaces around it with `joiner`. When `capNext`
// is set the first letter after the gap is capitalised in the same edit.
function joinAround(line: number, text: string, start: number, end: number, joiner: string, capNext: boolean): FixEdit {
	let s = start;
	while (s > 0 && text[s - 1] === ' ') {
		s--;
	}
	let e = end;
	while (e < text.length && text[e] === ' ') {
		e++;
	}
	if (capNext && e < text.length) {
		return { line, start: s, end: e + 1, text: joiner + text[e].toUpperCase() };
	}
	return { line, start: s, end: e, text: e < text.length ? joiner : joiner.trimEnd() };
}

export function fixesFor(rawCode: string, lineText: string, line: number, start: number, end: number, index: ReadingsIndex | null): FixSpec[] {
	const code = CODE_ALIASES[rawCode] ?? rawCode;
	const found = lineText.slice(start, end);
	switch (code) {
		case 'unverified-quote': {
			const open = /^["“]/.test(found) ? 1 : 0;
			const close = /["”]$/.test(found) && found.length > 1 ? 1 : 0;
			const inner = found.slice(open, found.length - close);
			const snap = snapQuote(index, inner);
			if (!snap || snap.text === inner) {
				return [];
			}
			return [{
				title: `Snap to verified quote (${pageCite(snap.doc, snap.passage)})`,
				edits: [{ line, start: start + open, end: end - close, text: snap.text }],
				preferred: true,
			}];
		}
		case 'wide-page-range': {
			const c = parseCitations(lineText).find(x => x.start === start) ?? parseCitations(`(${found})`)[0];
			const range = /(pp?\.\s*)?(\d{1,4})\s*[-–]\s*\d{1,4}$/.exec(found);
			if (!c || c.pageStart === null || !range) {
				return [];
			}
			const at = start + range.index;
			const fixes: FixSpec[] = [{
				title: `Pinpoint starting page (${c.surname} ${c.year}: ${c.pageStart})`,
				edits: [{ line, start: at, end: at + range[0].length, text: (range[1] ? 'p. ' : '') + c.pageStart }],
			}];
			const target = index ? resolveCitation(index, c)?.passages[0] : undefined;
			if (target) {
				fixes.push({
					title: 'Open reading to check page',
					edits: [],
					command: { command: 'writerStudio.openReadingBeside', title: 'Open reading to check page', arguments: [target.filePath, target.line] },
				});
			}
			return fixes;
		}
		case 'em-dash':
			return [
				{ title: 'Replace em dash with comma', edits: [joinAround(line, lineText, start, end, ', ', false)] },
				{ title: 'Split into two sentences', edits: [joinAround(line, lineText, start, end, '. ', true)] },
			];
		case 'hedge-verb': {
			const swap = HEDGE_SWAPS.find(([re]) => re.test(found.replace(/\s+/g, ' ')));
			if (!swap) {
				return [];
			}
			return swap[1].map(word => ({
				title: `Replace with "${word}"`,
				edits: [{ line, start, end, text: matchCase(found, word) }],
			}));
		}
		case 'semicolon': {
			const rest = lineText.slice(end).trimStart();
			const comma = CONJUNCTION.test(rest) ? ', ' : ', and ';
			return [
				{ title: 'Replace semicolon with period', edits: [joinAround(line, lineText, start, end, '. ', true)] },
				{ title: comma === ', ' ? 'Replace semicolon with comma' : 'Replace semicolon with comma and "and"', edits: [joinAround(line, lineText, start, end, comma, false)] },
			];
		}
		default:
			return [];
	}
}

// ---------------------------------------------------------------------------
// VS Code wiring

function codeOf(d: vscodeTypes.Diagnostic): string {
	const c = d.code;
	return typeof c === 'object' && c !== null ? String(c.value) : String(c ?? '');
}

export function createQuickFixProvider(vscode: typeof vscodeTypes, getIndex: () => ReadingsIndex | null): vscodeTypes.CodeActionProvider {
	return {
		provideCodeActions(doc, _range, context) {
			const actions: vscodeTypes.CodeAction[] = [];
			for (const d of context.diagnostics) {
				if (d.source !== 'Writer' || d.range.start.line !== d.range.end.line) {
					continue;
				}
				const line = d.range.start.line;
				const specs = fixesFor(codeOf(d), doc.lineAt(line).text, line, d.range.start.character, d.range.end.character, getIndex());
				for (const spec of specs) {
					const action = new vscode.CodeAction(spec.title, vscode.CodeActionKind.QuickFix);
					action.diagnostics = [d];
					action.isPreferred = spec.preferred ?? false;
					if (spec.edits.length) {
						const edit = new vscode.WorkspaceEdit();
						for (const e of spec.edits) {
							edit.replace(doc.uri, new vscode.Range(e.line, e.start, e.line, e.end), e.text);
						}
						action.edit = edit;
					}
					if (spec.command) {
						action.command = spec.command;
					}
					actions.push(action);
				}
			}
			return actions;
		},
	};
}

export function registerQuickFixes(vscode: typeof vscodeTypes, getIndex: () => ReadingsIndex | null): vscodeTypes.Disposable {
	return vscode.languages.registerCodeActionsProvider(
		{ language: 'markdown' },
		createQuickFixProvider(vscode, getIndex),
		{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
	);
}
