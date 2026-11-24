// Two quiet CodeLenses above each prose paragraph of a Markdown draft: its
// evidence status, and one next move when something is missing.
// buildParagraphLenses() is pure; the provider at the bottom wires it to vscode.

import type * as vscodeTypes from 'vscode';
import type { Bookmark, ParagraphOutlineNode, RawAnswer } from '../shared/protocol';
import { analyzeOutline, SHORT_WORDS, TARGET_SOURCES } from './argumentOutline';
import type { ReadingsIndex } from './readingsIndex';

export interface LensSpec {
	line: number; // 1-based paragraph start
	title: string;
	command: string;
	args: unknown[];
}

export function statusTitle(n: ParagraphOutlineNode): string {
	const words = n.words === 1 ? '1 word' : `${n.words} words`;
	const quotes = n.quoteCount === 1 ? '1 quote' : `${n.quoteCount} quotes`;
	return `${words} · ${n.distinctSources}/${TARGET_SOURCES} sources · ${quotes}`;
}

const EVIDENCE_GAP = /sources$|^no direct quote$/;

// A short paragraph gets slots to grow into. A paragraph missing evidence
// gets the reading that matches it best, when readings are indexed.
export function actionFor(n: ParagraphOutlineNode, hasReadings: boolean): Omit<LensSpec, 'line' | 'args'> | null {
	const evidenceGap = n.gaps.some(g => EVIDENCE_GAP.test(g));
	if (hasReadings && evidenceGap && n.words >= SHORT_WORDS / 2) {
		return { title: 'Open matching reading', command: 'writerStudio.openParagraphReading' };
	}
	if (n.gaps.length || n.words < SHORT_WORDS) {
		return { title: 'Insert paragraph skeleton', command: 'writerStudio.insertSkeleton' };
	}
	return null;
}

export function buildParagraphLenses(outline: ParagraphOutlineNode[], hasReadings: boolean, uri?: unknown): LensSpec[] {
	const out: LensSpec[] = [];
	for (const n of outline) {
		out.push({ line: n.line, title: statusTitle(n), command: 'writerStudio.openPanel', args: [] });
		const action = actionFor(n, hasReadings);
		if (action) {
			const args = action.command === 'writerStudio.insertSkeleton' ? [undefined, uri, n.line] : [uri, n.line];
			out.push({ line: n.line, ...action, args });
		}
	}
	return out;
}

// The reading passage closest to a paragraph, scored as if the paragraph were an answer.
export function matchReadingForParagraph(index: ReadingsIndex | null, paragraphText: string): Bookmark | null {
	if (!index || !index.size || !paragraphText.trim()) {
		return null;
	}
	const probe: RawAnswer = { id: 'paragraph', timestamp: '', prompt: 'this paragraph', text: paragraphText };
	return index.matchBookmarks([probe], 1)[0] ?? null;
}

// ---------------------------------------------------------------------------
// VS Code wiring

export interface ParagraphLensProvider extends vscodeTypes.CodeLensProvider, vscodeTypes.Disposable {
	refresh(): void;
}

export function createParagraphLensProvider(
	vscode: typeof vscodeTypes,
	getAnswers: () => RawAnswer[],
	getIndex: () => ReadingsIndex | null,
	isEnabled: () => boolean,
	shouldShow: (doc: vscodeTypes.TextDocument) => boolean,
	busyLine: (doc: vscodeTypes.TextDocument) => number | undefined = () => undefined, // 0-based line whose lens row is taken
): ParagraphLensProvider {
	const changed = new vscode.EventEmitter<void>();
	return {
		onDidChangeCodeLenses: changed.event,
		provideCodeLenses(doc) {
			if (!isEnabled() || !shouldShow(doc)) {
				return [];
			}
			const outline = analyzeOutline(doc.getText(), getAnswers());
			const hasReadings = (getIndex()?.size ?? 0) > 0;
			const busy = busyLine(doc);
			return buildParagraphLenses(outline, hasReadings, doc.uri).filter(spec => spec.line - 1 !== busy).map(spec => {
				const range = new vscode.Range(spec.line - 1, 0, spec.line - 1, 0);
				return new vscode.CodeLens(range, { title: spec.title, command: spec.command, arguments: spec.args });
			});
		},
		refresh() {
			changed.fire();
		},
		dispose() {
			changed.dispose();
		},
	};
}
