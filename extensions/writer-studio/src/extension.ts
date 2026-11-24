import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Bookmark, ChatMessage, LaunchTarget, LintDiagnostic, ParagraphOutlineNode, QuestionContext, RawAnswer, StateMessage, WebviewToExtension } from './shared/protocol';
import { analyzeOutline, ArgumentOutlineTreeProvider, paragraphAtLine, splitParagraphs } from './core/argumentOutline';
import { registerCitationNav } from './core/citationNav';
import { Companion, askClaude } from './core/companion';
import { Draft, OPENING, buildMindMapPrompt, parseMindMap, readState, respond, transcript } from './core/assistant';
import { registerStraighten, straightenLine } from './core/straighten';
import { registerNudges } from './core/nudge';
import { PDF_VIEW_TYPE, registerPdfReader } from './core/pdfEditor';
import { registerResearchBrowser } from './core/researchBrowser';
import { createParagraphLensProvider, matchReadingForParagraph, ParagraphLensProvider } from './core/paragraphLens';
import { registerQuickFixes } from './core/quickFixes';
import { ReadingsIndex } from './core/readingsIndex';
import { getSkeletonText, planSkeletonInsert, SKELETON_OPTIONS, SLOT } from './core/skeletons';
import { analyzeDocument, createSlopLinter, Finding, shouldLint, SlopLinter } from './core/slopLinter';
import { buildCoaxingStarters, buildQuestionContext, pickQuestion, QUESTIONS, WorkflowStore } from './core/workflowStore';

const CURSOR_KEY = 'writerStudio.questionCursor';
const DRAFT_DEBOUNCE_MS = 400;

function config() {
	return vscode.workspace.getConfiguration('writerStudio');
}

function toProtocol(f: Finding): LintDiagnostic {
	return { line: f.line, col: f.col, severity: f.severity, code: f.code, message: f.message, excerpt: f.excerpt };
}

class WriterStudio implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;
	private index: ReadingsIndex | null = null;
	private indexGeneration = 0;
	private bookmarks: Bookmark[] = [];
	private coaxOffset = 0;
	private lastMarkdownEditor: vscode.TextEditor | undefined;
	private readonly findings = new Map<string, Finding[]>();
	private questionCache: { key: string; value: QuestionContext } | null = null;
	private draftTimer: ReturnType<typeof setTimeout> | undefined;
	private chatBusy = false;
	private chatError = '';
	private pendingText = ''; // shown in the chat while the reply is on its way
	readonly linter: SlopLinter;
	readonly outlineTree = new ArgumentOutlineTreeProvider(vscode);
	readonly lenses: ParagraphLensProvider;
	outlineView: vscode.TreeView<unknown> | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.linter = createSlopLinter(
			vscode,
			() => this.index,
			() => config().get<boolean>('enableLiveLint', true),
			(doc, findings) => {
				this.findings.set(doc.uri.toString(), findings);
				if (doc === this.markdownEditor()?.document) {
					this.postState();
				}
			},
		);
		this.lenses = createParagraphLensProvider(
			vscode,
			() => this.store()?.readAnswers() ?? [],
			() => this.index,
			() => config().get<boolean>('enableParagraphLens', true),
			shouldLint,
			doc => straightenLine(doc.uri.toString()),
		);
	}

	dispose(): void {
		clearTimeout(this.draftTimer);
	}

	getIndex(): ReadingsIndex | null {
		return this.index;
	}

	store(): WorkflowStore | null {
		const folder = vscode.workspace.workspaceFolders?.[0];
		return folder ? new WorkflowStore(folder.uri.fsPath) : null;
	}

	markdownEditor(): vscode.TextEditor | undefined {
		const active = vscode.window.activeTextEditor;
		if (active && shouldLint(active.document)) {
			return active;
		}
		const last = this.lastMarkdownEditor;
		return last && !last.document.isClosed ? last : undefined;
	}

	trackEditor(editor: vscode.TextEditor | undefined): void {
		if (editor && shouldLint(editor.document)) {
			this.lastMarkdownEditor = editor;
		}
		this.refreshOutline();
		this.postState();
	}

	// ---- outline --------------------------------------------------------

	private outlineFor(editor: vscode.TextEditor | undefined, answers: RawAnswer[]): ParagraphOutlineNode[] {
		return editor ? analyzeOutline(editor.document.getText(), answers) : [];
	}

	refreshOutline(): void {
		const editor = this.markdownEditor();
		this.outlineTree.update(this.outlineFor(editor, this.store()?.readAnswers() ?? []), editor?.document.uri);
		if (this.outlineView) {
			this.outlineView.message = editor ? undefined : 'Open a Markdown draft to see its paragraphs.';
		}
	}

	// Typing in the draft: one outline and panel refresh once the writer pauses.
	draftChanged(doc: vscode.TextDocument): void {
		if (doc !== this.markdownEditor()?.document) {
			return;
		}
		clearTimeout(this.draftTimer);
		this.draftTimer = setTimeout(() => {
			this.draftTimer = undefined;
			this.refreshOutline();
			this.postState();
		}, DRAFT_DEBOUNCE_MS);
	}

	private async editorFor(uri: unknown): Promise<vscode.TextEditor | undefined> {
		if (uri instanceof vscode.Uri || (uri && typeof (uri as vscode.Uri).fsPath === 'string')) {
			const target = (uri as vscode.Uri).toString();
			const visible = vscode.window.visibleTextEditors?.find(e => e.document.uri.toString() === target);
			if (visible) {
				return visible;
			}
			const doc = await vscode.workspace.openTextDocument(uri as vscode.Uri);
			return vscode.window.showTextDocument(doc);
		}
		return this.markdownEditor();
	}

	async jumpToLine(line: number, uri?: unknown): Promise<void> {
		const editor = await this.editorFor(uri);
		if (!editor || !Number.isFinite(line)) {
			return;
		}
		const target = Math.min(Math.max(0, line - 1), editor.document.lineCount - 1);
		const range = new vscode.Range(target, 0, target, editor.document.lineAt(target).text.length);
		const shown = await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, selection: range });
		shown.revealRange(range, vscode.TextEditorRevealType.InCenter);
	}

	// Only on request: the command, a lens click or the panel button.
	async insertSkeleton(skeletonId?: string, uri?: unknown, line?: number): Promise<void> {
		const editor = await this.editorFor(uri);
		if (!editor) {
			vscode.window.showInformationMessage('VSwriter: open a Markdown draft to insert a paragraph skeleton.');
			return;
		}
		let id = typeof skeletonId === 'string' ? skeletonId : undefined;
		if (!id) {
			const pick = await vscode.window.showQuickPick(
				SKELETON_OPTIONS.map(o => ({ label: o.label, detail: o.description, id: o.id })),
				{ placeHolder: 'Insert a paragraph skeleton' },
			);
			id = pick?.id;
		}
		const text = id ? getSkeletonText(id) : null;
		if (!text) {
			return;
		}
		const doc = editor.document;
		const lines = doc.getText().split(/\r?\n/);
		const cursor = typeof line === 'number' && Number.isFinite(line) ? line - 1 : editor.selection.active.line;
		const plan = planSkeletonInsert(lines, cursor, text);
		// The webview holds focus when its button is pressed, and a hidden editor
		// cannot be edited: bring the draft forward first.
		const target = await vscode.window.showTextDocument(doc, { viewColumn: editor.viewColumn, preserveFocus: false });
		const done = await target.edit(b => b.insert(new vscode.Position(plan.line, plan.character), plan.text));
		if (!done) {
			return;
		}
		// Select the first slot so typing replaces it.
		const slotLine = Math.min(plan.firstSlotLine, doc.lineCount - 1);
		const slot = new RegExp(SLOT.source).exec(doc.lineAt(slotLine).text);
		const selection = slot
			? new vscode.Selection(slotLine, slot.index, slotLine, slot.index + slot[0].length)
			: new vscode.Selection(slotLine, 0, slotLine, 0);
		const shown = await vscode.window.showTextDocument(doc, { viewColumn: editor.viewColumn, selection });
		shown.revealRange(selection, vscode.TextEditorRevealType.InCenter);
	}

	async openParagraphReading(uri?: unknown, line?: number): Promise<void> {
		const editor = await this.editorFor(uri);
		if (!editor) {
			return;
		}
		const at = typeof line === 'number' && Number.isFinite(line) ? line : editor.selection.active.line + 1;
		const paragraph = paragraphAtLine(splitParagraphs(editor.document.getText()), at);
		const match = paragraph ? matchReadingForParagraph(this.index, paragraph.text) : null;
		if (!match) {
			vscode.window.showInformationMessage('VSwriter: no indexed reading matches this paragraph yet. Check writerStudio.readingsDirs.');
			return;
		}
		await this.openReading(match.filePath, match.line);
	}

	// ---- readings -------------------------------------------------------

	async rebuildIndex(): Promise<void> {
		const generation = ++this.indexGeneration;
		const readingDirs = config().get<string[]>('readingsDirs', []);
		const workspaceDirs = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
		const building = ReadingsIndex.build(readingDirs, workspaceDirs);
		vscode.window.setStatusBarMessage('VSwriter: indexing readings', building);
		const index = await building;
		if (generation !== this.indexGeneration) {
			return; // a newer rebuild started meanwhile
		}
		this.index = index;
		this.questionCache = null;
		this.rematch();
		this.linter.lintOpenDocuments();
		this.lenses.refresh();
		this.postState();
	}

	private rematch(): void {
		const answers = this.store()?.readAnswers() ?? [];
		this.bookmarks = this.index ? this.index.matchBookmarks(answers, 6) : [];
	}

	async openReading(filePath: string, line: number): Promise<void> {
		// Only files the index knows about: the webview cannot open arbitrary paths.
		if (!this.index?.docs.some(d => d.filePath === filePath)) {
			vscode.window.showWarningMessage('VSwriter: that reading is no longer in the index. Refresh bookmarks and try again.');
			return;
		}
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
		const target = Math.min(Math.max(0, line - 1), doc.lineCount - 1);
		const range = new vscode.Range(target, 0, target, doc.lineAt(target).text.length);
		const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true, selection: range });
		editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
	}

	// ---- interview ------------------------------------------------------

	private cursor(): number {
		return this.context.workspaceState.get<number>(CURSOR_KEY, 0);
	}

	initWorkspace(): void {
		const store = this.store();
		if (!store) {
			vscode.window.showWarningMessage('VSwriter: open the assignment folder first. raw-answers.md, interview-state.md and source-map.md are kept there.');
			return;
		}
		const created = store.init();
		if (created.length) {
			vscode.window.showInformationMessage(`VSwriter: created ${created.join(', ')}.`);
		}
		this.postState();
	}

	private submitAnswer(prompt: string, text: string): void {
		const store = this.store();
		if (!store) {
			this.initWorkspace();
			return;
		}
		if (!text.trim()) {
			return;
		}
		store.init();
		store.appendAnswer(prompt || pickQuestion(store.readAnswers(), this.cursor()), text);
		this.coaxOffset = 0;
		this.rematch();
		this.answersChanged();
		this.postState();
	}

	private async nextQuestion(): Promise<void> {
		const current = pickQuestion(this.store()?.readAnswers() ?? [], this.cursor());
		await this.context.workspaceState.update(CURSOR_KEY, (QUESTIONS.indexOf(current) + 1) % QUESTIONS.length);
		this.postState();
	}

	// ---- lint -----------------------------------------------------------

	runLint(): void {
		const editor = this.markdownEditor();
		if (!editor) {
			vscode.window.showInformationMessage('VSwriter: open a Markdown draft to lint it.');
			return;
		}
		this.linter.lint(editor.document);
		this.postState();
	}

	private answersChanged(): void {
		this.refreshOutline();
		this.lenses.refresh();
	}

	// ---- webview --------------------------------------------------------

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		view.webview.html = this.html(view.webview, media);
		view.webview.onDidReceiveMessage((msg: WebviewToExtension) => this.handle(msg));
		view.onDidChangeVisibility(() => view.visible && this.postState());
		view.onDidDispose(() => {
			this.view = undefined;
		});
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const file = vscode.Uri.joinPath(media, 'panel.html').fsPath;
		if (!fs.existsSync(file)) {
			return '<!DOCTYPE html><html><body><p>media/panel.html is missing from the extension.</p></body></html>';
		}
		const values: Record<string, string> = {
			'{{CSP_SOURCE}}': webview.cspSource,
			'{{NONCE}}': crypto.randomBytes(16).toString('hex'),
			'{{CSS_URI}}': webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css')).toString(),
			'{{JS_URI}}': webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js')).toString(),
			'{{CHAT_JS_URI}}': webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js')).toString(),
		};
		let html = fs.readFileSync(file, 'utf8');
		for (const [placeholder, value] of Object.entries(values)) {
			html = html.split(placeholder).join(value);
		}
		return html;
	}

	private async handle(msg: WebviewToExtension): Promise<void> {
		switch (msg.type) {
			case 'ready':
				this.postState();
				this.postChat();
				break;
			case 'chatSend':
				await this.sendChat(String(msg.text ?? ''));
				break;
			case 'launch':
				await this.launch(msg.what);
				break;
			case 'mindMap':
				await this.mindMap();
				break;
			case 'initWorkspace':
				this.initWorkspace();
				break;
			case 'submitAnswer':
				this.submitAnswer(String(msg.prompt ?? ''), String(msg.text ?? ''));
				break;
			case 'nextQuestion':
				await this.nextQuestion();
				break;
			case 'refreshBookmarks':
				await this.rebuildIndex();
				break;
			case 'openReading':
				await this.openReading(String(msg.filePath), Number(msg.line));
				break;
			case 'generateCoax':
				this.coaxOffset++;
				this.postState();
				break;
			case 'jumpDiagnostic':
			case 'jumpLine':
				await this.jumpToLine(Number(msg.line));
				break;
			case 'insertSkeleton':
				// Unknown ids are ignored: the webview can only pick from SKELETON_OPTIONS.
				if (SKELETON_OPTIONS.some(o => o.id === msg.skeletonId)) {
					await this.insertSkeleton(msg.skeletonId);
				}
				break;
		}
	}

	// ---- assistant chat ---------------------------------------------------

	postChat(): void {
		const store = this.store();
		const state = store ? readState(store) : { phase: 'define' as const, brief: '', question: OPENING };
		const turns = store ? transcript(store, state) : [{ role: 'assistant' as const, text: 'Open the folder for this piece (File > Open Folder) and we can start.' }];
		if (this.chatBusy && this.pendingText) {
			turns.splice(turns.length - 1, 0, { role: 'writer', text: this.pendingText });
		}
		const msg: ChatMessage = { type: 'chat', turns, busy: this.chatBusy, phase: state.phase, brief: state.brief, error: this.chatError };
		void this.view?.webview.postMessage(msg);
	}

	private draft(): Draft | null {
		const editor = this.markdownEditor();
		return editor ? { name: path.basename(editor.document.fileName), text: editor.document.getText(), line: editor.selection.active.line } : null;
	}

	private async readingNames(): Promise<string[]> {
		const files = await vscode.workspace.findFiles('**/*.{pdf,PDF,md}', '**/{node_modules,.git}/**', 200);
		return files
			.map(u => vscode.workspace.asRelativePath(u))
			.filter(r => /\.pdf$/i.test(r) || /(^|\/)(readings?|sources?)\//i.test(r))
			.slice(0, 60);
	}

	private async sendChat(text: string): Promise<void> {
		const store = this.store();
		if (!store || !text.trim() || this.chatBusy) {
			return;
		}
		this.chatBusy = true;
		this.chatError = '';
		this.pendingText = text;
		this.postChat();
		try {
			const model = config().get<string>('companion.model', 'claude-sonnet-5-5');
			await respond(store, text, this.draft(), await this.readingNames(), prompt => askClaude(model, prompt, o => /"reply"\s*:/.test(o)));
		} catch (err) {
			this.chatError = `The assistant did not answer (${(err as Error).message.slice(0, 160)}). Your message is saved; send another to try again.`;
		} finally {
			this.chatBusy = false;
			this.pendingText = '';
			this.answersChanged();
			this.postState();
			this.postChat();
		}
	}

	private async mindMap(): Promise<void> {
		const store = this.store();
		if (!store || this.chatBusy) {
			return;
		}
		const state = readState(store);
		const history = transcript(store, state).slice(0, -1);
		if (!history.some(t => t.role === 'writer')) {
			this.chatError = 'Answer a few questions first; the mind map is built from the interview.';
			this.postChat();
			return;
		}
		this.chatBusy = true;
		this.chatError = '';
		this.postChat();
		try {
			const model = config().get<string>('companion.model', 'claude-sonnet-5-5');
			const map = parseMindMap(await askClaude(model, buildMindMapPrompt(state, history, this.draft()), o => /mindmap/.test(o)));
			if (!map) throw new Error('no mind map came back');
			const file = path.join(store.root, 'mind-map.md');
			fs.writeFileSync(file, `# Mind map\n\nBuilt from the interview on ${new Date().toLocaleString()}. Ask for a new one any time.\n\n\`\`\`mermaid\n${map}\n\`\`\`\n`, 'utf8');
			await vscode.commands.executeCommand('markdown.showPreviewToSide', vscode.Uri.file(file));
		} catch (err) {
			this.chatError = `The mind map could not be made (${(err as Error).message.slice(0, 160)}).`;
		} finally {
			this.chatBusy = false;
			this.postChat();
		}
	}

	// ---- launcher -------------------------------------------------------

	private async launch(what: LaunchTarget): Promise<void> {
		switch (what) {
			case 'pdf': {
				const picked = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { PDF: ['pdf'] }, openLabel: 'Open beside draft' });
				const folder = vscode.workspace.workspaceFolders?.[0];
				for (const uri of picked ?? []) {
					let target = uri;
					// Readings from elsewhere are copied into readings/ so search and suggestions see them.
					if (folder && !uri.fsPath.startsWith(folder.uri.fsPath + path.sep)) {
						const dir = path.join(folder.uri.fsPath, 'readings');
						fs.mkdirSync(dir, { recursive: true });
						const dest = path.join(dir, path.basename(uri.fsPath));
						if (!fs.existsSync(dest)) fs.copyFileSync(uri.fsPath, dest);
						target = vscode.Uri.file(dest);
					}
					await vscode.commands.executeCommand('vscode.openWith', target, PDF_VIEW_TYPE, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
				}
				break;
			}
			case 'browser':
				// Straight to a search page; the address bar is there for anything else.
				await vscode.commands.executeCommand('writerStudio.openBrowserBeside', 'https://www.google.com/');
				break;
			case 'capture':
				await vscode.commands.executeCommand('writerStudio.captureWebPage');
				break;
			case 'lint':
				this.runLint();
				break;
			case 'terminal':
			case 'claude': {
				const terminal = vscode.window.createTerminal({ name: what === 'claude' ? 'Claude' : 'Terminal' });
				terminal.show();
				// Beside the writing, not under it.
				await vscode.commands.executeCommand('workbench.action.positionPanelRight');
				if (what === 'claude') terminal.sendText('claude');
				break;
			}
		}
	}

	private state(): StateMessage {
		const store = this.store();
		const answers = store?.readAnswers() ?? [];
		const editor = this.markdownEditor();
		let findings: Finding[] = [];
		if (editor) {
			const key = editor.document.uri.toString();
			if (!this.findings.has(key) && config().get<boolean>('enableLiveLint', true)) {
				this.findings.set(key, analyzeDocument(editor.document.getText(), this.index));
			}
			findings = this.findings.get(key) ?? [];
		}
		const currentQuestion = pickQuestion(answers, this.cursor());
		return {
			type: 'state',
			workspaceReady: store?.isReady() ?? false,
			activeFile: editor?.document.uri.fsPath ?? null,
			rawAnswers: answers,
			currentQuestion,
			bookmarks: this.bookmarks,
			coaxing: buildCoaxingStarters(answers, this.bookmarks, this.coaxOffset),
			diagnostics: findings.map(toProtocol),
			questionContext: this.questionContext(currentQuestion, answers),
			outline: this.outlineFor(editor, answers),
			skeletons: SKELETON_OPTIONS,
		};
	}

	// Matching passages costs a BM25 pass per answer: reuse it until the
	// question, the answers or the index change.
	private questionContext(question: string, answers: RawAnswer[]): QuestionContext {
		const key = `${this.indexGeneration}|${this.index ? 1 : 0}|${question}|${answers.map(a => a.id).join(',')}`;
		if (this.questionCache?.key !== key) {
			this.questionCache = { key, value: buildQuestionContext(question, answers, this.index) };
		}
		return this.questionCache.value;
	}

	postState(): void {
		if (this.view) {
			this.view.webview.postMessage(this.state());
		}
	}

	onWorkflowFilesChanged(): void {
		this.rematch();
		this.answersChanged();
		this.postState();
	}

	forget(doc: vscode.TextDocument): void {
		this.findings.delete(doc.uri.toString());
	}

	liveLintChanged(): void {
		this.findings.clear();
		this.linter.lintOpenDocuments();
		this.postState();
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const studio = new WriterStudio(context);
	const watcher = vscode.workspace.createFileSystemWatcher('**/{raw-answers,interview-state,source-map}.md');
	const outlineView = vscode.window.createTreeView('writerStudio.outline', { treeDataProvider: studio.outlineTree });
	studio.outlineView = outlineView as vscode.TreeView<unknown>;

	// v0.3: PDF reader and research browser beside the draft.
	const pdf = registerPdfReader(vscode, {
		extensionUri: context.extensionUri,
		globalStorageDir: context.globalStorageUri?.fsPath ?? path.join(os.homedir(), '.vswriter'),
		draftEditor: () => studio.markdownEditor(),
	});
	const companionLog = vscode.window.createOutputChannel('VSwriter Companion');
	const companion = new Companion(vscode, {
		pdf: pdf.provider,
		isDraft: doc => doc.uri.scheme === 'file' && shouldLint(doc),
		log: line => companionLog.appendLine(`${new Date().toISOString()} ${line}`),
	});
	const research = registerResearchBrowser(vscode, {
		onSourceCaptured: () => studio.rebuildIndex(),
		openPdf: uri => vscode.commands.executeCommand('vscode.openWith', uri, PDF_VIEW_TYPE, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }),
	});

	context.subscriptions.push(
		...pdf.disposables,
		...research.disposables,
		companion,
		companionLog,
		...registerStraighten(vscode, () => config().get<string>('companion.model', 'claude-sonnet-5-5'), line => companionLog.appendLine(`${new Date().toISOString()} ${line}`), () => studio.lenses.refresh()),
		...registerNudges(vscode, {
			isDraft: doc => doc.uri.scheme === 'file' && shouldLint(doc),
			context: () => {
				const store = studio.store();
				if (!store) return null;
				const state = readState(store);
				return { root: store.root, state, history: transcript(store, state).slice(0, -1), answers: store.readAnswers().map(a => a.text) };
			},
			ask: prompt => askClaude(config().get<string>('companion.model', 'claude-sonnet-5-5'), prompt, o => /"bubbles"\s*:/.test(o)),
			saveReply: (bubble, reply) => {
				const store = studio.store();
				if (!store) return;
				store.init();
				store.appendAnswer(bubble, reply);
				studio.postChat();
			},
			stuckSeconds: () => config().get<number>('nudge.stuckSeconds', 45),
			log: line => companionLog.appendLine(`${new Date().toISOString()} ${line}`),
		}),
		studio,
		studio.linter,
		studio.lenses,
		watcher,
		outlineView,
		vscode.window.registerWebviewViewProvider('writerStudio.panel', studio),
		registerCitationNav(vscode, () => studio.getIndex()),
		registerQuickFixes(vscode, () => studio.getIndex()),
		vscode.languages.registerCodeLensProvider({ language: 'markdown' }, studio.lenses),

		vscode.commands.registerCommand('writerStudio.openPanel', async () => {
			await vscode.commands.executeCommand('workbench.view.extension.writer-studio');
			await vscode.commands.executeCommand('writerStudio.panel.focus');
		}),
		vscode.commands.registerCommand('writerStudio.refreshBookmarks', () => studio.rebuildIndex()),
		vscode.commands.registerCommand('writerStudio.runLint', () => studio.runLint()),
		vscode.commands.registerCommand('writerStudio.initWorkspace', () => studio.initWorkspace()),
		vscode.commands.registerCommand('writerStudio.openReadingBeside', async (filePath?: string, line?: number) => {
			if (typeof filePath === 'string') {
				return studio.openReading(filePath, Number(line) || 1);
			}
			const index = studio.getIndex();
			const answers = studio.store()?.readAnswers() ?? [];
			const picks = (index?.matchBookmarks(answers, 6) ?? []).map(b => ({
				label: `${b.author} (${b.year}${b.page ? ': ' + b.page : ''})`,
				detail: b.excerpt,
				description: b.reason,
				bookmark: b,
			}));
			if (!picks.length) {
				vscode.window.showInformationMessage('VSwriter: no bookmarks yet. Save an answer and check writerStudio.readingsDirs.');
				return;
			}
			const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Open a reading beside the draft', matchOnDetail: true });
			if (pick) {
				await studio.openReading(pick.bookmark.filePath, pick.bookmark.line);
			}
		}),

		vscode.commands.registerCommand('writerStudio.insertSkeleton', (skeletonId?: string, uri?: unknown, line?: number) => studio.insertSkeleton(skeletonId, uri, line)),
		vscode.commands.registerCommand('writerStudio.jumpToLine', (line?: number, uri?: unknown) => studio.jumpToLine(Number(line), uri)),
		vscode.commands.registerCommand('writerStudio.openParagraphReading', (uri?: unknown, line?: number) => studio.openParagraphReading(uri, line)),

		vscode.window.onDidChangeActiveTextEditor(editor => studio.trackEditor(editor)),
		vscode.workspace.onDidCloseTextDocument(doc => studio.forget(doc)),
		// With live lint off, findings stay until the next Run Lint; drop them once the text moves on.
		vscode.workspace.onDidChangeTextDocument(e => {
			if (!config().get<boolean>('enableLiveLint', true)) {
				studio.forget(e.document);
			}
			studio.draftChanged(e.document);
		}),
		watcher.onDidChange(() => studio.onWorkflowFilesChanged()),
		watcher.onDidCreate(() => studio.onWorkflowFilesChanged()),
		watcher.onDidDelete(() => studio.onWorkflowFilesChanged()),
		vscode.workspace.onDidChangeWorkspaceFolders(() => studio.rebuildIndex()),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('writerStudio.readingsDirs')) {
				studio.rebuildIndex();
			}
			if (e.affectsConfiguration('writerStudio.enableLiveLint')) {
				studio.liveLintChanged();
			}
			if (e.affectsConfiguration('writerStudio.enableParagraphLens')) {
				studio.lenses.refresh();
			}
		}),
	);

	studio.trackEditor(vscode.window.activeTextEditor);
	studio.rebuildIndex();
}

export function deactivate(): void {}
