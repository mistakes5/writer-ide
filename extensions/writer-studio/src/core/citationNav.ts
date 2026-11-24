// Author-Date citations such as (Mellamphy 2021: 20) or (Carlson 2015: 424):
// parsing, resolution against the local readings, and the hover/definition
// providers. The vscode module is passed in so the parsing stays testable.

import type * as vscodeTypes from 'vscode';
import type { Passage, ReadingDoc, ReadingsIndex } from './readingsIndex';

export interface Citation {
	surname: string;
	year: string;
	pageStart: number | null;
	pageEnd: number | null;
	start: number; // offsets of this citation inside the parsed string
	end: number;
	text: string;
}

export interface Resolution {
	doc: ReadingDoc;
	passages: Passage[];
	notes: string[];
}

const YEAR = '(?:1[89]|20)\\d{2}';
const GROUP = new RegExp(`\\(([^()]*?\\b${YEAR}[a-z]?\\b[^()]*)\\)`, 'g');
const NAME = "\\p{Lu}[\\p{L}'’-]+";
const ONE = new RegExp(
	`^(?:(?:[Ss]ee|[Cc]f\\.|e\\.g\\.,?)\\s+)?(${NAME}(?:\\s+${NAME})?)` +
	`(?:\\s+(?:and|&)\\s+${NAME}|\\s+et al\\.)?,?\\s+(${YEAR})[a-z]?` +
	`(?:\\s*[:,]\\s*(?:pp?\\.\\s*)?(\\d{1,4})(?:\\s*[-–]\\s*(\\d{1,4}))?)?$`,
	'u',
);

// "424-26" means 424 to 426.
function expandRangeEnd(start: number, endText: string): number {
	const end = Number(endText);
	if (end >= start || endText.length >= String(start).length) {
		return end;
	}
	const head = String(start).slice(0, String(start).length - endText.length);
	return Number(head + endText);
}

export function parseCitations(text: string): Citation[] {
	const out: Citation[] = [];
	for (const group of text.matchAll(GROUP)) {
		const inner = group[1];
		let offset = group.index! + 1;
		for (const part of inner.split(';')) {
			const lead = part.length - part.trimStart().length;
			const trimmed = part.trim();
			const m = ONE.exec(trimmed);
			if (m) {
				const pageStart = m[3] ? Number(m[3]) : null;
				out.push({
					surname: m[1],
					year: m[2],
					pageStart,
					pageEnd: m[4] && pageStart !== null ? expandRangeEnd(pageStart, m[4]) : pageStart,
					start: offset + lead,
					end: offset + lead + trimmed.length,
					text: trimmed,
				});
			}
			offset += part.length + 1;
		}
	}
	return out;
}

export function citationAt(lineText: string, character: number): Citation | null {
	return parseCitations(lineText).find(c => character >= c.start && character <= c.end) ?? null;
}

export function resolveCitation(index: ReadingsIndex, c: Citation): Resolution | null {
	const docs = index.findDocs(c.surname);
	if (!docs.length) {
		return null;
	}
	const sameYear = docs.filter(d => d.year === c.year);
	const pool = sameYear.length ? sameYear : docs;
	const notes: string[] = [];
	const yearNote = (d: ReadingDoc) => {
		if (d.year !== c.year) {
			notes.push(`The local copy is dated ${d.year}. You cited ${c.year}, so check that the page numbers come from the same edition.`);
		}
	};
	if (c.pageStart === null) {
		yearNote(pool[0]);
		return { doc: pool[0], passages: pool[0].passages.slice(0, 1), notes };
	}
	for (const doc of pool) {
		const passages = index.passagesOnPage(doc, c.pageStart);
		if (passages.length) {
			yearNote(doc);
			const kind = passages[0].pageKind;
			if (kind === 'inferred') {
				notes.push(`Page ${c.pageStart} carries no printed number in the extraction. It is counted from the nearest printed page.`);
			} else if (kind === 'pdf') {
				notes.push(`This reading has no printed page numbers, so page ${c.pageStart} was read as the PDF position.`);
			}
			return { doc, passages, notes };
		}
	}
	yearNote(pool[0]);
	notes.push(`Page ${c.pageStart} is outside the pages in the local copy.`);
	return { doc: pool[0], passages: [], notes };
}

const HOVER_CHARS = 1200;

function escapeMarkdown(s: string): string {
	return s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

export function formatHover(c: Citation, r: Resolution | null, fileLink: (p: Passage) => string): string {
	if (!r) {
		return escapeMarkdown(`No indexed reading has an author named ${c.surname}.`);
	}
	const parts: string[] = [];
	const page = c.pageStart === null ? '' : c.pageEnd !== c.pageStart ? `, pp. ${c.pageStart}-${c.pageEnd}` : `, p. ${c.pageStart}`;
	parts.push(`**${escapeMarkdown(`${r.doc.author} ${r.doc.year}${page}`)}**  \n${escapeMarkdown(r.doc.title)}`);
	let used = 0;
	for (const p of r.passages) {
		if (used >= HOVER_CHARS) {
			break;
		}
		const text = p.text.length > HOVER_CHARS - used ? p.text.slice(0, HOVER_CHARS - used) + ' [...]' : p.text;
		used += text.length;
		parts.push(`> ${escapeMarkdown(text)}\n\n[${escapeMarkdown(`line ${p.line}`)}](${fileLink(p)})`);
	}
	for (const note of r.notes) {
		parts.push(`*${escapeMarkdown(note)}*`);
	}
	return parts.join('\n\n');
}

export function registerCitationNav(vscode: typeof vscodeTypes, getIndex: () => ReadingsIndex | null): vscodeTypes.Disposable {
	const selector: vscodeTypes.DocumentSelector = { language: 'markdown' };
	const lookup = (doc: vscodeTypes.TextDocument, pos: vscodeTypes.Position) => {
		const index = getIndex();
		const c = index ? citationAt(doc.lineAt(pos.line).text, pos.character) : null;
		return index && c ? { c, r: resolveCitation(index, c) } : null;
	};
	const fileLink = (p: Passage) => vscode.Uri.file(p.filePath).with({ fragment: `L${p.line}` }).toString();

	const hover = vscode.languages.registerHoverProvider(selector, {
		provideHover(doc, pos) {
			const found = lookup(doc, pos);
			if (!found) {
				return undefined;
			}
			const md = new vscode.MarkdownString(formatHover(found.c, found.r, fileLink));
			return new vscode.Hover(md, new vscode.Range(pos.line, found.c.start, pos.line, found.c.end));
		},
	});
	const definition = vscode.languages.registerDefinitionProvider(selector, {
		provideDefinition(doc, pos) {
			const found = lookup(doc, pos);
			const target = found?.r?.passages[0];
			if (!target) {
				return undefined;
			}
			return new vscode.Location(vscode.Uri.file(target.filePath), new vscode.Position(target.line - 1, 0));
		},
	});
	return vscode.Disposable.from(hover, definition);
}
