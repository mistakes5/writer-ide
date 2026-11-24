// Straighten: the lightest possible AI pass over a passage the writer marks.
// It acts on the writer's notes to themselves (a bracketed "change this", a
// "check", an arrow that means "continue from here"), fixes plain errors and
// leaves everything else alone. The change is proposed inline as a word diff
// with Accept / Deny / Reply above it, like an agent asking for permission.

import type * as vscodeTypes from 'vscode';
import { extractJson } from './assistant';
import { askClaude } from './companion';

export interface Proposal {
	uri: string;
	version: number; // document version the proposal was made against
	range: vscodeTypes.Range;
	original: string;
	text: string;
	notes: string[];
}

export type Op = { kind: 'same' | 'del' | 'ins'; text: string };

/** Word-level diff (whitespace kept as its own tokens), by longest common subsequence. */
export function wordDiff(a: string, b: string): Op[] {
	const x = a.split(/(\s+)/).filter(t => t !== '');
	const y = b.split(/(\s+)/).filter(t => t !== '');
	const n = x.length, m = y.length;
	const L: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
	const ops: Op[] = [];
	const push = (kind: Op['kind'], text: string) => {
		const last = ops[ops.length - 1];
		if (last && last.kind === kind) last.text += text;
		else ops.push({ kind, text });
	};
	let i = 0, j = 0;
	while (i < n && j < m) {
		if (x[i] === y[j]) { push('same', x[i]); i++; j++; }
		else if (L[i + 1][j] >= L[i][j + 1]) { push('del', x[i]); i++; }
		else { push('ins', y[j]); j++; }
	}
	while (i < n) push('del', x[i++]);
	while (j < m) push('ins', y[j++]);
	return ops;
}

export function buildPrompt(passage: string, feedback?: { previous: string; reply: string }): string {
	return [
		'Straighten this passage from a writer\'s draft, as lightly as possible. It is their writing, not yours.',
		'- Carry out the notes they left for themselves (a bracketed or parenthetical instruction, TODO, "check", "??") and then remove those notes. Make each change as small as the note allows.',
		'- Fix only clear errors: spelling, capital letters, punctuation, a sentence that does not parse.',
		'- Keep their words, rhythm, tone and opinions everywhere else, even where you would write it differently.',
		'- Where they marked a place to continue (an arrow like ---> or >>>, "...", "continue"), replace the marker with at most one short sentence that carries their thought on in their voice.',
		'- Never change a fact or a claim. When something needs checking, leave it and say so in notes.',
		'Return ONLY JSON: {"text": "<the straightened passage>", "notes": ["<one short line per change made or fact to check>"]}',
		'',
		`PASSAGE:\n${passage}`,
		...(feedback ? ['', `YOUR LAST VERSION:\n${feedback.previous}`, '', `THE WRITER REPLIED: ${feedback.reply}`, 'Revise your version to follow their reply, still as lightly as possible.'] : []),
	].join('\n');
}

type Straightened = { text: string; notes?: unknown };
const isStraightened = (v: unknown): v is Straightened => !!v && typeof (v as Straightened).text === 'string' && (v as Straightened).text.trim() !== '';

export function parse(raw: string): { text: string; notes: string[] } | null {
	const j = extractJson(raw, isStraightened);
	if (!j) return null;
	const notes = Array.isArray(j.notes) ? j.notes.filter((n): n is string => typeof n === 'string' && n.trim() !== '').map(n => n.trim()) : [];
	return { text: j.text.trim(), notes };
}

// The proposal waiting for Accept / Deny / Reply. One at a time, across the window.
let pending: Proposal | undefined;

/** The line a pending proposal's buttons sit on, so other lenses can give up that row. */
export function straightenLine(uri: string): number | undefined {
	return pending && pending.uri === uri ? pending.range.start.line : undefined;
}

const short = (note: string) => (note.length > 60 ? `${note.slice(0, 57)}…` : note);

export function registerStraighten(vscode: typeof vscodeTypes, model: () => string, log: (line: string) => void, changed: () => void = () => {}): vscodeTypes.Disposable[] {
	let busy = false;
	const lensChanged = new vscode.EventEmitter<void>();
	const removed = vscode.window.createTextEditorDecorationType({
		textDecoration: 'line-through',
		color: new vscode.ThemeColor('disabledForeground'),
		backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
	});
	const added = vscode.window.createTextEditorDecorationType({});
	const insertColor = new vscode.ThemeColor('diffEditor.insertedTextBackground');

	const paint = () => {
		for (const editor of vscode.window.visibleTextEditors) {
			const mine = pending && editor.document.uri.toString() === pending.uri;
			if (!mine || !pending) {
				editor.setDecorations(removed, []);
				editor.setDecorations(added, []);
				continue;
			}
			const doc = editor.document;
			let at = doc.offsetAt(pending.range.start);
			const dels: vscodeTypes.Range[] = [];
			const ins: vscodeTypes.DecorationOptions[] = [];
			for (const op of wordDiff(pending.original, pending.text)) {
				if (op.kind === 'ins') {
					ins.push({
						range: new vscode.Range(doc.positionAt(at), doc.positionAt(at)),
						hoverMessage: `✦ Straighten adds: ${op.text.trim()}`,
						renderOptions: { before: { contentText: op.text, backgroundColor: insertColor, color: new vscode.ThemeColor('editor.foreground') } },
					});
					continue;
				}
				if (op.kind === 'del') dels.push(new vscode.Range(doc.positionAt(at), doc.positionAt(at + op.text.length)));
				at += op.text.length;
			}
			editor.setDecorations(removed, dels);
			editor.setDecorations(added, ins);
		}
	};

	const clear = () => {
		pending = undefined;
		paint();
		lensChanged.fire();
		changed();
	};

	// The paragraph under the cursor, or the selection when there is one.
	const target = (editor: vscodeTypes.TextEditor): vscodeTypes.Range | undefined => {
		if (!editor.selection.isEmpty) return new vscode.Range(editor.selection.start, editor.selection.end);
		const doc = editor.document;
		let a = editor.selection.active.line, b = a;
		if (!doc.lineAt(a).text.trim()) return undefined;
		while (a > 0 && doc.lineAt(a - 1).text.trim()) a--;
		while (b < doc.lineCount - 1 && doc.lineAt(b + 1).text.trim()) b++;
		return new vscode.Range(a, 0, b, doc.lineAt(b).text.length);
	};

	const propose = async (editor: vscodeTypes.TextEditor, range: vscodeTypes.Range, original: string, feedback?: { previous: string; reply: string }) => {
		if (busy) return;
		busy = true;
		try {
			const result = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Window, title: '$(sparkle) Straightening' },
				async () => parse(await askClaude(model(), buildPrompt(original, feedback), o => /"text"\s*:/.test(o))),
			);
			if (!result) {
				void vscode.window.showWarningMessage('VSwriter: Straighten got no usable answer. Try again.');
				return;
			}
			if (result.text === original.trim()) {
				void vscode.window.showInformationMessage('VSwriter: nothing to straighten here.');
				clear();
				return;
			}
			pending = { uri: editor.document.uri.toString(), version: editor.document.version, range, original, text: result.text, notes: result.notes };
			log(`straighten: ${result.notes.length} notes, ${wordDiff(original, result.text).filter(o => o.kind !== 'same').length} changes`);
			paint();
			lensChanged.fire();
			changed();
		} catch (err) {
			log(`straighten: ${(err as Error).message}`);
			void vscode.window.showWarningMessage(`VSwriter: Straighten failed (${(err as Error).message.slice(0, 120)}).`);
		} finally {
			busy = false;
		}
	};

	const lenses: vscodeTypes.CodeLensProvider = {
		onDidChangeCodeLenses: lensChanged.event,
		provideCodeLenses(doc) {
			if (!pending || doc.uri.toString() !== pending.uri) return [];
			const at = new vscode.Range(pending.range.start, pending.range.start);
			const items: vscodeTypes.CodeLens[] = [
				new vscode.CodeLens(at, { title: '$(check) Accept', command: 'writerStudio.straighten.accept' }),
				new vscode.CodeLens(at, { title: '$(close) Deny', command: 'writerStudio.straighten.deny' }),
				new vscode.CodeLens(at, { title: '$(reply) Reply', command: 'writerStudio.straighten.reply' }),
			];
			for (const note of pending.notes.slice(0, 4)) items.push(new vscode.CodeLens(at, { title: `$(sparkle) ${short(note)}`, tooltip: note, command: '' }));
			return items;
		},
	};

	return [
		removed,
		added,
		lensChanged,
		vscode.languages.registerCodeLensProvider({ language: 'markdown' }, lenses),
		vscode.window.onDidChangeVisibleTextEditors(paint),
		// Typing inside the passage makes the proposal stale.
		vscode.workspace.onDidChangeTextDocument(e => {
			if (pending && e.document.uri.toString() === pending.uri && e.contentChanges.some(c => c.range.intersection(pending!.range) || c.range.end.isBefore(pending!.range.start))) clear();
		}),
		vscode.commands.registerCommand('writerStudio.straighten', async () => {
			const editor = vscode.window.activeTextEditor;
			const range = editor && target(editor);
			if (!editor || !range) {
				void vscode.window.showInformationMessage('VSwriter: put the cursor in a paragraph, or select a passage, to straighten it.');
				return;
			}
			await propose(editor, range, editor.document.getText(range));
		}),
		vscode.commands.registerCommand('writerStudio.straighten.accept', async () => {
			const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === pending?.uri);
			if (!pending || !editor) return;
			const { range, text } = pending;
			clear();
			await editor.edit(edit => edit.replace(range, text));
		}),
		vscode.commands.registerCommand('writerStudio.straighten.deny', clear),
		vscode.commands.registerCommand('writerStudio.straighten.reply', async () => {
			const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === pending?.uri);
			if (!pending || !editor) return;
			const reply = await vscode.window.showInputBox({ prompt: 'What should Straighten do differently?', placeHolder: 'e.g. keep "speed of light", only fix the fire metaphor' });
			if (!reply?.trim()) return;
			const { range, original, text } = pending;
			await propose(editor, range, original, { previous: text, reply });
		}),
	];
}
