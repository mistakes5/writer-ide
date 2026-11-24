// Argument outline: the draft's prose paragraphs with their evidence counts
// and plain-language gaps, so the writer can see structure without holding it
// in their head. analyzeOutline() is pure; the tree view at the bottom shows
// its result in the VSwriter sidebar.

import type * as vscodeTypes from 'vscode';
import type { ParagraphOutlineNode, RawAnswer } from '../shared/protocol';
import { parseCitations } from './citationNav';
import { tokenize } from './readingsIndex';
import { SLOT } from './skeletons';

export const TARGET_SOURCES = 3;
export const SHORT_WORDS = 80;
export const LONG_WORDS = 250;
const PREVIEW_CHARS = 75;
const MIN_QUOTE_CHARS = 15;
const MAX_MATCHED_ANSWERS = 3;

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BACK_MATTER = /^(?:bibliography|references|works cited|sources|reference list|sources cited)$/i;
const INTRO = /\b(?:intro|introduction)\b/i;
const CONCLUSION = /\b(?:conclusion|conclusions|concluding)\b/i;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE = /^\s*\|/;
const FENCE = /^\s*(```|~~~)/;
const COMMENT = /<!--[\s\S]*?-->/g;
const QUOTE = /“([^”]+)”|"([^"]+)"/g;
const COUNTER = /\b(?:yet|however|although|though|caveat|limit|limits|limited|limitation|limitations|objection|objections|trade-?offs?|trade offs?)\b/i;
// Narrative citations: Mellamphy (2021: 17), Carlson et al. (2015).
const NARRATIVE = /(\p{Lu}[\p{L}'’-]+)(?:\s+(?:and|&)\s+\p{Lu}[\p{L}'’-]+|\s+et al\.)?\s+\(((?:1[89]|20)\d{2})[a-z]?(?:\s*[:,][^()]*)?\)/gu;

interface RawParagraph {
	line: number; // 1-based
	heading: string;
	text: string;
}

// Prose paragraphs only: front matter, fenced code, headings, rules, tables
// and block quotes are skipped, and everything after a Bibliography or
// References heading is back matter.
export function splitParagraphs(text: string): RawParagraph[] {
	const lines = text.split(/\r?\n/);
	const out: RawParagraph[] = [];
	let heading = '(Opening)';
	let current: RawParagraph | null = null;
	let inFence = false;
	let inComment = false;
	const flush = () => {
		if (current) {
			out.push(current);
			current = null;
		}
	};

	let i = 0;
	if (lines[0]?.trim() === '---') {
		const close = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
		i = close > 0 ? close + 1 : 0;
	}
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (FENCE.test(line)) {
			flush();
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			continue;
		}
		// Multi-line HTML comments hold notes to self, never prose.
		if (inComment) {
			if (line.includes('-->')) {
				inComment = false;
			}
			continue;
		}
		if (line.includes('<!--') && !line.slice(line.indexOf('<!--')).includes('-->')) {
			inComment = true;
			if (!line.slice(0, line.indexOf('<!--')).trim()) {
				continue;
			}
		}
		const h = HEADING.exec(line);
		if (h) {
			flush();
			heading = h[2].replace(/[*_`]/g, '').trim() || heading;
			if (BACK_MATTER.test(heading)) {
				break;
			}
			continue;
		}
		if (!line.trim() || RULE.test(line) || TABLE.test(line) || /^\s*>/.test(line)) {
			flush();
			continue;
		}
		if (current) {
			current.text += '\n' + line;
		} else {
			current = { line: i + 1, heading, text: line };
		}
	}
	flush();
	return out;
}

// The paragraph's own words: no comments, no unfilled slots, no Markdown marks.
function proseOf(text: string): string {
	return text
		.replace(COMMENT, ' ')
		.replace(SLOT, ' ')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
		.replace(/[*_`]+/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function countWords(prose: string): number {
	return (prose.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

function preview(prose: string): string {
	if (prose.length <= PREVIEW_CHARS) {
		return prose;
	}
	const cut = prose.slice(0, PREVIEW_CHARS - 3);
	const space = cut.lastIndexOf(' ');
	return (space > PREVIEW_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '') + '...';
}

export function distinctSources(prose: string): number {
	const keys = new Set<string>();
	for (const c of parseCitations(prose)) {
		keys.add(`${c.surname.toLowerCase()} ${c.year}`);
	}
	for (const m of prose.matchAll(NARRATIVE)) {
		keys.add(`${m[1].toLowerCase()} ${m[2]}`);
	}
	return keys.size;
}

export function quoteCount(prose: string): number {
	let n = 0;
	for (const m of prose.matchAll(QUOTE)) {
		if ((m[1] ?? m[2]).trim().length >= MIN_QUOTE_CHARS) {
			n++;
		}
	}
	return n;
}

// Raw answers that share at least three content words with the paragraph
// (two, for answers too short to share three).
export function matchAnswers(prose: string, answers: RawAnswer[]): string[] {
	const words = new Set(tokenize(prose).map(t => t.stem));
	const scored: Array<{ id: string; shared: number; order: number }> = [];
	answers.forEach((a, order) => {
		const stems = new Set(tokenize(a.text).map(t => t.stem));
		let shared = 0;
		for (const s of stems) {
			if (words.has(s)) {
				shared++;
			}
		}
		if (shared >= Math.min(3, Math.max(2, stems.size - 1))) {
			scored.push({ id: a.id, shared, order });
		}
	});
	return scored
		.sort((x, y) => y.shared - x.shared || y.order - x.order)
		.slice(0, MAX_MATCHED_ANSWERS)
		.map(s => s.id);
}

export function analyzeOutline(text: string, rawAnswers: RawAnswer[] = []): ParagraphOutlineNode[] {
	const nodes: ParagraphOutlineNode[] = [];
	for (const p of splitParagraphs(text)) {
		const prose = proseOf(p.text);
		const slots = (p.text.match(SLOT) ?? []).length;
		if (!prose && !slots) {
			continue;
		}
		const words = countWords(prose);
		const sources = distinctSources(prose);
		const quotes = quoteCount(prose);
		const node: ParagraphOutlineNode = {
			index: nodes.length + 1,
			line: p.line,
			heading: p.heading,
			preview: prose ? preview(prose) : '(empty skeleton)',
			words,
			distinctSources: sources,
			quoteCount: quotes,
			hasCounterMove: COUNTER.test(prose),
			gaps: [],
			matchedAnswerIds: prose ? matchAnswers(prose, rawAnswers) : [],
		};
		// Introductions and conclusions frame the argument; they are not held to the evidence count.
		const framing = INTRO.test(p.heading) || CONCLUSION.test(p.heading);
		if (slots) {
			node.gaps.push(slots === 1 ? '1 slot to fill' : `${slots} slots to fill`);
		}
		if (!framing && sources < TARGET_SOURCES) {
			node.gaps.push(`${sources}/${TARGET_SOURCES} sources`);
		}
		if (!framing && quotes === 0) {
			node.gaps.push('no direct quote');
		}
		if (words > 0 && words < SHORT_WORDS) {
			node.gaps.push(`under ${SHORT_WORDS} words`);
		} else if (words > LONG_WORDS) {
			node.gaps.push(`over ${LONG_WORDS} words, consider splitting`);
		}
		nodes.push(node);
	}
	// One counter-move somewhere is enough; flag only a draft with none at all.
	const body = nodes.filter(n => !INTRO.test(n.heading) && !CONCLUSION.test(n.heading));
	if (body.length >= 3 && !nodes.some(n => n.hasCounterMove)) {
		body[body.length - 1].gaps.push('no caveat or objection in the draft yet');
	}
	return nodes;
}

// The paragraph (or outline node) that starts at or above a 1-based line.
export function paragraphAtLine<T extends { line: number }>(items: T[], line: number): T | null {
	let found: T | null = null;
	for (const n of items) {
		if (n.line <= line) {
			found = n;
		}
	}
	return found;
}

// ---------------------------------------------------------------------------
// Sidebar tree: headings, then their paragraphs. Clicking a paragraph runs
// writerStudio.jumpToLine.

export type OutlineElement =
	| { kind: 'heading'; heading: string; nodes: ParagraphOutlineNode[] }
	| { kind: 'paragraph'; node: ParagraphOutlineNode };

export function metaLine(n: ParagraphOutlineNode): string {
	const quotes = n.quoteCount === 1 ? '1 quote' : `${n.quoteCount} quotes`;
	return `${n.words}w · ${n.distinctSources} src · ${quotes}`;
}

export class ArgumentOutlineTreeProvider implements vscodeTypes.TreeDataProvider<OutlineElement> {
	private readonly changed: vscodeTypes.EventEmitter<OutlineElement | undefined>;
	readonly onDidChangeTreeData: vscodeTypes.Event<OutlineElement | undefined>;
	private outline: ParagraphOutlineNode[] = [];
	private uri: vscodeTypes.Uri | undefined;

	constructor(private readonly vscode: typeof vscodeTypes) {
		this.changed = new vscode.EventEmitter<OutlineElement | undefined>();
		this.onDidChangeTreeData = this.changed.event;
	}

	update(outline: ParagraphOutlineNode[], uri: vscodeTypes.Uri | undefined): void {
		this.outline = outline;
		this.uri = uri;
		this.changed.fire(undefined);
	}

	get nodes(): ParagraphOutlineNode[] {
		return this.outline;
	}

	getChildren(element?: OutlineElement): OutlineElement[] {
		if (element) {
			return element.kind === 'heading' ? element.nodes.map(node => ({ kind: 'paragraph', node })) : [];
		}
		const groups: Array<{ kind: 'heading'; heading: string; nodes: ParagraphOutlineNode[] }> = [];
		for (const node of this.outline) {
			const last = groups[groups.length - 1];
			if (last && last.heading === node.heading) {
				last.nodes.push(node);
			} else {
				groups.push({ kind: 'heading', heading: node.heading, nodes: [node] });
			}
		}
		// A draft without headings needs no grouping level.
		if (groups.length === 1 && groups[0].heading === '(Opening)') {
			return groups[0].nodes.map(node => ({ kind: 'paragraph', node }));
		}
		return groups;
	}

	getTreeItem(element: OutlineElement): vscodeTypes.TreeItem {
		const vscode = this.vscode;
		if (element.kind === 'heading') {
			const item = new vscode.TreeItem(element.heading, vscode.TreeItemCollapsibleState.Expanded);
			const open = element.nodes.reduce((sum, n) => sum + n.gaps.length, 0);
			item.description = open ? `${element.nodes.length} ¶ · ${open} gaps` : `${element.nodes.length} ¶`;
			return item;
		}
		const n = element.node;
		const item = new vscode.TreeItem(`P${n.index}  ${n.preview}`, vscode.TreeItemCollapsibleState.None);
		item.description = metaLine(n) + (n.gaps.length ? ` · ${n.gaps.join(' · ')}` : '');
		item.tooltip = [
			`P${n.index} · line ${n.line} · ${n.heading}`,
			metaLine(n),
			n.hasCounterMove ? 'Has a caveat or objection.' : '',
			n.gaps.length ? `Gaps: ${n.gaps.join(', ')}` : 'No gaps.',
			n.matchedAnswerIds.length ? `Linked to ${n.matchedAnswerIds.length} of your answers.` : '',
		].filter(Boolean).join('\n');
		item.iconPath = new vscode.ThemeIcon(n.gaps.length ? 'circle-outline' : 'pass');
		item.command = { command: 'writerStudio.jumpToLine', title: 'Go to paragraph', arguments: [n.line, this.uri] };
		return item;
	}
}
