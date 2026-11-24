// Drives activate() and the webview message protocol against a minimal fake
// of the vscode API, so the wiring is checked without launching the editor.

import { afterAll, expect, mock, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { StateMessage, WebviewToExtension } from '../src/shared/protocol';

const EXTENSION_ROOT = path.resolve(import.meta.dir, '..');
const MELLAMPHY = '/Users/admin/Documents/obsidian/school/2026-2027/POLISCI 3390F/Knowledge Library/Week 03/R022.md';

const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-ws-'));
const readingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-readings-'));
const readingCopy = path.join(readingsDir, 'R022.md');
fs.copyFileSync(MELLAMPHY, readingCopy);
afterAll(() => [workspaceDir, readingsDir].forEach(d => fs.rmSync(d, { recursive: true, force: true })));

const disposable = () => ({ dispose() {} });
const event = () => () => disposable();

class Uri {
	constructor(readonly fsPath: string, readonly fragment = '') {}
	static file(p: string) { return new Uri(p); }
	static joinPath(base: Uri, ...parts: string[]) { return new Uri(path.join(base.fsPath, ...parts)); }
	with(change: { fragment?: string }) { return new Uri(this.fsPath, change.fragment ?? this.fragment); }
	toString() { return 'file://' + this.fsPath + (this.fragment ? '#' + this.fragment : ''); }
}
class Position { constructor(readonly line: number, readonly character: number) {} }
class Range {
	constructor(readonly startLine: number, readonly startCol: number, readonly endLine: number, readonly endCol: number) {}
	get start() { return new Position(this.startLine, this.startCol); }
	get end() { return new Position(this.endLine, this.endCol); }
}
class Selection extends Range {
	get active() { return this.end; }
}
class EventEmitter<T> {
	private listeners: Array<(e: T) => void> = [];
	event = (fn: (e: T) => void) => { this.listeners.push(fn); return disposable(); };
	fire(e: T) { this.listeners.forEach(fn => fn(e)); }
	dispose() {}
}

const commands = new Map<string, (...args: unknown[]) => unknown>();
const shown: Array<{ path: string; options: any }> = [];
const warnings: string[] = [];
const diagnosticsSet = new Map<string, unknown[]>();
let provider: any;
let lensProvider: any;
let actionProvider: any;
let actionKinds: unknown;
let treeView: any;
const customEditors = new Map<string, unknown>();
const infos: string[] = [];

function fakeDocument(fileName: string, initial: string) {
	let text = initial;
	return {
		languageId: fileName.endsWith('.md') ? 'markdown' : 'plaintext',
		fileName,
		uri: Uri.file(fileName),
		isClosed: false,
		get lineCount() { return text.split('\n').length; },
		getText: () => text,
		lineAt: (i: number) => ({ text: text.split('\n')[i] ?? '' }),
		insert(pos: Position, s: string) {
			const lines = text.split('\n');
			const offset = lines.slice(0, pos.line).reduce((n, l) => n + l.length + 1, 0) + pos.character;
			text = text.slice(0, offset) + s + text.slice(offset);
		},
	};
}

function fakeEditor(document: ReturnType<typeof fakeDocument>, line = 0) {
	return {
		document,
		viewColumn: 1,
		selection: new Selection(line, 0, line, 0),
		edit: async (cb: (b: { insert(p: Position, s: string): void }) => void) => { cb({ insert: (p, s) => document.insert(p, s) }); return true; },
	};
}

const draft = fakeDocument(path.join(workspaceDir, 'draft.md'), 'The appeal is theater — nobody reads it.\nThey leverage the rules; nobody checks.');
const draftEditor = fakeEditor(draft);
const fakeWindow = {
	activeTextEditor: draftEditor as any,
	get visibleTextEditors() { return [this.activeTextEditor]; },
	createTreeView: (id: string, options: any) => { treeView = { id, ...options, message: undefined as string | undefined, dispose() {} }; return treeView; },
	createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
	createStatusBarItem: () => ({ text: "", tooltip: undefined, show() {}, hide() {}, dispose() {} }),
	registerWebviewViewProvider: (_id: string, p: unknown) => { provider = p; return disposable(); },
	registerCustomEditorProvider: (id: string, p: unknown) => { customEditors.set(id, p); return disposable(); },
	setStatusBarMessage: () => disposable(),
	showWarningMessage: (m: string) => { warnings.push(m); },
	showInformationMessage: (m: string) => { infos.push(m); },
	showQuickPick: async () => undefined,
	onDidChangeActiveTextEditor: event(),
	tabGroups: { all: [], onDidChangeTabs: event() },
	onDidChangeVisibleTextEditors: event(),
	state: { focused: true },
	createTextEditorDecorationType: () => ({ dispose() {} }),
	showTextDocument: async (doc: any, options: any) => {
		shown.push({ path: doc.fileName, options });
		return { ...fakeEditor(doc), viewColumn: options?.viewColumn, revealRange() {} };
	},
};

mock.module('vscode', () => ({
	Uri, Position, Range, Selection, EventEmitter,
	ThemeColor: class { constructor(readonly id: string) {} },
	ProgressLocation: { Window: 10, Notification: 15 },
	CodeLens: class { constructor(readonly range: Range, readonly command: any) {} },
	CodeActionKind: { QuickFix: 'quickfix' },
	CodeAction: class { diagnostics?: unknown[]; isPreferred?: boolean; edit?: any; command?: unknown; constructor(readonly title: string, readonly kind: string) {} },
	WorkspaceEdit: class { replacements: Array<{ uri: Uri; range: Range; text: string }> = []; replace(uri: Uri, range: Range, text: string) { this.replacements.push({ uri, range, text }); } },
	TreeItem: class { description?: string; tooltip?: string; iconPath?: unknown; command?: any; constructor(readonly label: string, readonly collapsibleState: number) {} },
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	ThemeIcon: class { constructor(readonly id: string) {} },
	Location: class { constructor(readonly uri: Uri, readonly pos: Position) {} },
	Hover: class { constructor(readonly contents: unknown, readonly range: Range) {} },
	MarkdownString: class { constructor(readonly value: string) {} },
	Diagnostic: class { source = ''; code = ''; constructor(readonly range: Range, readonly message: string, readonly severity: number) {} },
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
	ViewColumn: { Beside: -2 },
	StatusBarAlignment: { Left: 1, Right: 2 },
	TextEditorRevealType: { InCenter: 2 },
	Disposable: { from: () => disposable() },
	window: fakeWindow,
	env: { clipboard: { readText: async () => '', writeText: async () => undefined } },
	commands: {
		registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => { commands.set(id, fn); return disposable(); },
		executeCommand: async () => undefined,
	},
	comments: { createCommentController: () => ({ dispose() {}, createCommentThread: () => ({ dispose() {} }) }) },
	CommentMode: { Editing: 0, Preview: 1 },
	CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
	MarkdownString: class { constructor(readonly value = '') {} },
	languages: {
		createDiagnosticCollection: () => ({
			set: (uri: Uri, ds: unknown[]) => diagnosticsSet.set(uri.fsPath, ds),
			delete: () => undefined,
			clear: () => diagnosticsSet.clear(),
			dispose() {},
		}),
		registerHoverProvider: () => disposable(),
		registerCodeLensProvider: (_s: unknown, p: any) => { if (p.refresh) lensProvider = p; return disposable(); }, // the paragraph lens (it has refresh), not Straighten's
		registerCodeActionsProvider: (_s: unknown, p: unknown, meta: any) => { actionProvider = p; actionKinds = meta?.providedCodeActionKinds; return disposable(); },
		registerDefinitionProvider: () => disposable(),
	},
	workspace: {
		workspaceFolders: [{ uri: Uri.file(workspaceDir) }],
		textDocuments: [draft],
		getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'readingsDirs' ? [readingsDir] : fallback }),
		openTextDocument: async (uri: Uri) => fakeDocument(uri.fsPath, fs.readFileSync(uri.fsPath, 'utf8')),
		createFileSystemWatcher: () => ({ onDidChange: event(), onDidCreate: event(), onDidDelete: event(), dispose() {} }),
		onDidOpenTextDocument: event(),
		onDidChangeTextDocument: event(),
		onDidCloseTextDocument: event(),
		onDidChangeWorkspaceFolders: event(),
		onDidChangeConfiguration: event(),
	},
}));

async function waitFor<T>(check: () => T | undefined, ms = 5000): Promise<T> {
	const start = Date.now();
	for (;;) {
		const value = check();
		if (value) {
			return value;
		}
		if (Date.now() - start > ms) {
			throw new Error('timed out');
		}
		await new Promise(r => setTimeout(r, 20));
	}
}

test('activate wires commands, the webview and the full message protocol', async () => {
	const { activate } = await import('../src/extension');
	const memento = new Map<string, unknown>();
	activate({
		subscriptions: [],
		extensionUri: Uri.file(EXTENSION_ROOT),
		workspaceState: { get: (k: string, d: unknown) => memento.get(k) ?? d, update: async (k: string, v: unknown) => { memento.set(k, v); } },
	} as any);

	expect([...commands.keys()].sort()).toEqual([
		'writerStudio.captureWebPage', 'writerStudio.initWorkspace', 'writerStudio.insertSkeleton', 'writerStudio.jumpToLine',
		'writerStudio.nudge', 'writerStudio.nudge.dismiss', 'writerStudio.nudge.reply',
		'writerStudio.openBrowserBeside', 'writerStudio.openPanel', 'writerStudio.openParagraphReading', 'writerStudio.openPdfBeside',
		'writerStudio.openReadingBeside', 'writerStudio.refreshBookmarks', 'writerStudio.runLint',
		'writerStudio.straighten', 'writerStudio.straighten.accept', 'writerStudio.straighten.deny', 'writerStudio.straighten.reply',
	]);
	expect([...customEditors.keys()]).toEqual(['writerStudio.pdfReader']);

	// The manifest contributes exactly the registered commands, the outline view and the lens setting.
	const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_ROOT, 'package.json'), 'utf8'));
	expect(manifest.version).toBe('0.3.0');
	expect(manifest.contributes.commands.map((c: { command: string }) => c.command).sort()).toEqual([...commands.keys()].sort());
	expect(manifest.contributes.views['writer-studio'].map((v: { id: string }) => v.id)).toEqual(['writerStudio.panel', 'writerStudio.outline']);
	expect(manifest.contributes.configuration.properties['writerStudio.enableParagraphLens']).toMatchObject({ type: 'boolean', default: true });

	// Outline tree, CodeLens and QuickFix providers are live.
	expect(treeView.id).toBe('writerStudio.outline');
	expect(treeView.treeDataProvider.nodes.map((n: { line: number }) => n.line)).toEqual([1]);
	expect(treeView.message).toBeUndefined();
	expect(actionKinds).toEqual(['quickfix']);
	const lenses = lensProvider.provideCodeLenses(draft, {});
	expect(lenses.map((l: any) => l.command.title)).toEqual(['13 words · 0/3 sources · 0 quotes', 'Insert paragraph skeleton']);
	expect(lenses[1].command).toMatchObject({ command: 'writerStudio.insertSkeleton', arguments: [undefined, draft.uri, 1] });

	// Webview HTML from media/panel.html with every placeholder filled.
	const posted: StateMessage[] = [];
	let send!: (m: WebviewToExtension) => Promise<void>;
	const view = {
		visible: true,
		onDidChangeVisibility: event(),
		onDidDispose: event(),
		webview: {
			options: {} as any,
			html: '',
			cspSource: 'vscode-webview://test',
			asWebviewUri: (u: Uri) => ({ toString: () => 'vscode-webview://test' + u.fsPath }),
			postMessage: async (m: StateMessage) => { posted.push(m); return true; },
			onDidReceiveMessage: (cb: (m: WebviewToExtension) => Promise<void>) => { send = cb; return disposable(); },
		},
	};
	provider.resolveWebviewView(view);
	const html = view.webview.html;
	expect(html).not.toContain('{{');
	expect(html).toContain('vscode-webview://test' + path.join(EXTENSION_ROOT, 'media/panel.css'));
	expect(html).toContain('vscode-webview://test' + path.join(EXTENSION_ROOT, 'media/panel.js'));
	const nonces = [...html.matchAll(/nonce(?:-|=")([0-9a-f]{32})/g)].map(m => m[1]);
	expect(nonces.length).toBeGreaterThanOrEqual(2);
	expect(new Set(nonces).size).toBe(1);
	expect(view.webview.options.enableScripts).toBe(true);

	await send({ type: 'ready' });
	const first = posted.filter((m: any) => m.type === 'state').at(-1);
	expect(first.workspaceReady).toBe(false);
	expect(first.activeFile).toBe(draft.fileName);
	expect(first.diagnostics.map(d => d.code)).toEqual(['em-dash', 'ai-vocabulary', 'semicolon']);
	expect(Object.keys(first.diagnostics[0]).sort()).toEqual(['code', 'col', 'excerpt', 'line', 'message', 'severity']);
	expect(first.diagnostics[0].excerpt).toBe('The appeal is theater — nobody reads it.');
	// v0.2 state fields.
	expect(first.outline).toEqual([{
		index: 1, line: 1, heading: '(Opening)', preview: 'The appeal is theater — nobody reads it. They leverage the rules...',
		words: 13, distinctSources: 0, quoteCount: 0, hasCounterMove: false,
		gaps: ['0/3 sources', 'no direct quote', 'under 80 words'], matchedAnswerIds: [],
	}]);
	expect(first.skeletons.map(k => k.id)).toEqual(['body-triangulate', 'caveat-tradeoff', 'synthesis-bridge']);
	expect(first.questionContext.question).toBe(first.currentQuestion);
	expect(first.questionContext.options.length).toBeGreaterThanOrEqual(2);
	expect(first.questionContext.featuredBookmarks).toEqual([]);

	await send({ type: 'initWorkspace' });
	expect(posted.filter((m: any) => m.type === 'state').at(-1).workspaceReady).toBe(true);
	for (const f of ['raw-answers.md', 'interview-state.md', 'source-map.md']) {
		expect(fs.existsSync(path.join(workspaceDir, f))).toBe(true);
	}

	const question = posted.filter((m: any) => m.type === 'state').at(-1).currentQuestion;
	await send({ type: 'submitAnswer', prompt: question, text: 'keeping a human in the loop gives people a feeling of control over machine decisions' });
	const withBookmarks = await waitFor(() => posted.find(s => s.type === 'state' && s.rawAnswers.length === 1 && s.bookmarks.length > 0));
	expect(withBookmarks.rawAnswers[0].prompt).toBe(question);
	expect(withBookmarks.currentQuestion).not.toBe(question);
	expect(withBookmarks.bookmarks[0].filePath).toBe(readingCopy);
	expect(withBookmarks.coaxing.basedOnAnswerId).toBe(withBookmarks.rawAnswers[0].id);
	expect(withBookmarks.coaxing.starters[0]).toContain('"keeping a human in the loop gives people a feeling of control over machine ..."');
	const featured = await waitFor(() => posted.find(s => s.type === 'state' && s.questionContext.featuredBookmarks.length > 0));
	expect(featured.questionContext.question).toBe(featured.currentQuestion);
	expect(featured.questionContext.featuredBookmarks.length).toBeLessThanOrEqual(2);
	expect(featured.questionContext.featuredBookmarks[0].filePath).toBe(readingCopy);
	expect(fs.readFileSync(path.join(workspaceDir, 'raw-answers.md'), 'utf8')).toContain('keeping a human in the loop');

	const before = posted.filter((m: any) => m.type === 'state').at(-1).currentQuestion;
	await send({ type: 'nextQuestion' });
	expect(posted.filter((m: any) => m.type === 'state').at(-1).currentQuestion).not.toBe(before);

	const b = withBookmarks.bookmarks[0];
	await send({ type: 'openReading', filePath: b.filePath, line: b.line });
	expect(shown[shown.length - 1]).toMatchObject({ path: readingCopy, options: { viewColumn: -2, preview: true } });
	expect(shown[shown.length - 1].options.selection.startLine).toBe(b.line - 1);

	const shownBefore = shown.length;
	await send({ type: 'openReading', filePath: '/etc/passwd', line: 1 });
	expect(shown.length).toBe(shownBefore);
	expect(warnings.some(w => w.includes('no longer in the index'))).toBe(true);

	await send({ type: 'jumpDiagnostic', line: 2 });
	expect(shown[shown.length - 1]).toMatchObject({ path: draft.fileName, options: { viewColumn: 1 } });
	expect(shown[shown.length - 1].options.selection.startLine).toBe(1);

	const coaxBefore = posted.filter((m: any) => m.type === 'state').at(-1).coaxing;
	await send({ type: 'generateCoax' });
	expect(posted.filter((m: any) => m.type === 'state').at(-1).coaxing.basedOnAnswerId).toBe(coaxBefore.basedOnAnswerId);

	await send({ type: 'jumpLine', line: 2 });
	expect(shown[shown.length - 1]).toMatchObject({ path: draft.fileName, options: { viewColumn: 1 } });
	expect(shown[shown.length - 1].options.selection.startLine).toBe(1);

	(commands.get('writerStudio.runLint') as () => void)();
	expect((diagnosticsSet.get(draft.fileName) ?? []).length).toBe(3);

	// insertSkeleton from the webview: unknown ids do nothing, a real one lands
	// after the cursor's paragraph with its first slot selected.
	const textBefore = draft.getText();
	await send({ type: 'insertSkeleton', skeletonId: '<img onerror=alert(1)>' });
	expect(draft.getText()).toBe(textBefore);
	await send({ type: 'insertSkeleton', skeletonId: 'caveat-tradeoff' });
	expect(draft.getText()).toStartWith(textBefore + '\n\n[Tension: ');
	const sel = shown[shown.length - 1].options.selection;
	expect([sel.startLine, sel.startCol, sel.endLine]).toEqual([3, 0, 3]);
	expect(draft.lineAt(3).text.slice(sel.startCol, sel.endCol)).toBe('[Tension: one sentence naming where your claim meets resistance.]');
	(commands.get('writerStudio.runLint') as () => void)();
	expect((diagnosticsSet.get(draft.fileName) ?? []).length).toBe(3);

	// QuickFix: a misquoted Mellamphy line snaps to the exact wording of the indexed reading.
	const quoted = fakeDocument(path.join(workspaceDir, 'essay.md'), 'Mellamphy insists that "Humans should never give up moral agency to machines" (Mellamphy 2021: 17).');
	fakeWindow.activeTextEditor = fakeEditor(quoted);
	(commands.get('writerStudio.runLint') as () => void)();
	const diags = diagnosticsSet.get(quoted.fileName) as any[];
	expect(diags.map(d => d.code)).toEqual(['unverified-quote']);
	const actions = actionProvider.provideCodeActions(quoted, diags[0].range, { diagnostics: diags });
	expect(actions.map((a: any) => a.title)).toEqual(['Snap to verified quote (Mellamphy 2021: p. 17)']);
	const [{ range, text }] = actions[0].edit.replacements;
	expect(text).toBe('Humans should never relinquish moral agency to machines');
	expect(fs.readFileSync(readingCopy, 'utf8').split('\n')[135]).toContain(text);
	const open = quoted.getText().indexOf('"') + 1;
	expect([range.startCol, range.endCol]).toEqual([open, quoted.getText().indexOf('"', open)]);

	// The outline follows the active draft; jumpToLine and openParagraphReading run from the tree and lenses.
	(provider as any).trackEditor(fakeWindow.activeTextEditor);
	expect(treeView.treeDataProvider.nodes[0]).toMatchObject({ distinctSources: 1, quoteCount: 1 });
	await (commands.get('writerStudio.jumpToLine') as (l: number, u: unknown) => Promise<void>)(1, quoted.uri);
	expect(shown[shown.length - 1].path).toBe(quoted.fileName);
	await (commands.get('writerStudio.openParagraphReading') as (u: unknown, l: number) => Promise<void>)(quoted.uri, 1);
	expect(shown[shown.length - 1]).toMatchObject({ path: readingCopy, options: { viewColumn: -2 } });
});
