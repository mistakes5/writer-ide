// The split-screen PDF reader: a read-only custom editor for *.pdf that hosts
// media/pdf.html (PDF.js), stores highlights and bookmarks through pdfStore,
// and sends quotes to the draft or to source-map.md. The vscode module is
// passed in so the wiring runs under plain `bun test` with a fake.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscodeTypes from 'vscode';
import type { HighlightColor, PdfHostToWebview, PdfSuggestion, PdfWebviewToHost } from '../shared/pdfProtocol';
import {
	addHighlight,
	annotationsPath,
	appendHighlightToSourceMap,
	deleteBookmark,
	deleteHighlight,
	formatQuoteForDraft,
	HIGHLIGHT_COLORS,
	loadPdfAnnotations,
	pdfKey,
	PdfAnnotations,
	savePdfAnnotations,
	toggleBookmark,
	updateHighlightNote,
} from './pdfStore';

export const PDF_VIEW_TYPE = 'writerStudio.pdfReader';
export const PDF_TEMPLATE = 'pdf.html';
export const PDF_PLACEHOLDERS = ['{{CSP_SOURCE}}', '{{NONCE}}', '{{PDF_CSS_URI}}', '{{PDF_JS_URI}}', '{{PDF_WORKER_URI}}', '{{PDF_APP_URI}}'] as const;
type Placeholder = (typeof PDF_PLACEHOLDERS)[number];

// Replaces every occurrence of every placeholder. Values are URIs and a hex
// nonce, so a plain split/join is enough and avoids `$&` surprises in replace().
export function fillTemplate(template: string, values: Record<Placeholder, string>): string {
	let html = template;
	for (const key of PDF_PLACEHOLDERS) {
		html = html.split(key).join(values[key]);
	}
	return html;
}

const MISSING_TEMPLATE = '<!DOCTYPE html><html><body><p>media/pdf.html is missing from the extension.</p></body></html>';

// ---------------------------------------------------------------------------
// Trust boundary: everything from the webview is checked here

const isStr = (v: unknown): v is string => typeof v === 'string';
const isPage = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;

export function parsePdfMessage(raw: unknown): PdfWebviewToHost | null {
	const m = (raw ?? {}) as Record<string, unknown>;
	switch (m.type) {
		case 'pdfReady':
			return { type: 'pdfReady' };
		case 'pdfText':
			return typeof m.reqId === 'number' && Array.isArray(m.pages) && m.pages.every(isStr) ? { type: 'pdfText', reqId: m.reqId, pages: m.pages as string[] } : null;
		case 'addHighlight': {
			const h = (m.highlight ?? {}) as Record<string, unknown>;
			if (!isPage(h.page) || !isStr(h.text) || !h.text.trim() || !HIGHLIGHT_COLORS.includes(h.color as HighlightColor)) {
				return null;
			}
			return {
				type: 'addHighlight',
				highlight: { page: h.page, text: h.text, note: isStr(h.note) ? h.note : '', color: h.color as HighlightColor, rects: Array.isArray(h.rects) ? h.rects : [] },
			};
		}
		case 'deleteHighlight':
		case 'deleteBookmark':
			return isStr(m.id) ? { type: m.type, id: m.id } : null;
		case 'updateHighlightNote':
			return isStr(m.id) && isStr(m.note) ? { type: 'updateHighlightNote', id: m.id, note: m.note } : null;
		case 'toggleBookmark':
			return isPage(m.page) ? { type: 'toggleBookmark', page: m.page, label: isStr(m.label) ? m.label : '' } : null;
		case 'sendToDraft':
		case 'appendToSourceMap':
			return isPage(m.page) && isStr(m.text) && m.text.trim() ? { type: m.type, text: m.text, page: m.page, fileName: isStr(m.fileName) ? m.fileName : '' } : null;
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Draft insertion

const OPENERS = /[\s([{“‘"'—–-]/;

// Pads an inline quote so it reads as part of the sentence, and sets a block
// quote off as its own paragraph.
export function padQuote(quote: string, before: string, after: string): string {
	if (quote.startsWith('> ')) {
		const lead = before.trim() ? '\n\n' : '';
		const tail = after.trim() ? '\n\n' : '';
		return lead + quote + tail;
	}
	const lead = before && !OPENERS.test(before.slice(-1)) ? ' ' : '';
	const tail = after && /^[\p{L}\p{N}]/u.test(after) ? ' ' : '';
	return lead + quote + tail;
}

export interface PdfReaderDeps {
	extensionUri: vscodeTypes.Uri;
	globalStorageDir: string;
	// The draft the writer is working on (the studio's Markdown editor), if any.
	draftEditor: () => vscodeTypes.TextEditor | undefined;
	onSourceMapChanged?: () => void;
}

interface OpenPdf {
	panel: vscodeTypes.WebviewPanel;
	notesFile: string;
	key: string;
}

export class PdfReaderProvider implements vscodeTypes.CustomReadonlyEditorProvider {
	private readonly open = new Map<string, OpenPdf>();
	private readonly pendingPage = new Map<string, number>();
	private readonly textRequests = new Map<number, (pages: string[]) => void>();
	private nextReq = 1;

	/** PDFs open in a reader right now. */
	openUris(): vscodeTypes.Uri[] {
		return [...this.open.keys()].map(k => this.vscode.Uri.parse(k));
	}

	/** Page texts as PDF.js reads them; empty when the reader is closed or slow. */
	extractText(uri: vscodeTypes.Uri, timeoutMs = 15000): Promise<string[]> {
		const entry = this.open.get(uri.toString());
		if (!entry) {
			return Promise.resolve([]);
		}
		const reqId = this.nextReq++;
		return new Promise(resolve => {
			const timer = setTimeout(() => { this.textRequests.delete(reqId); resolve([]); }, timeoutMs);
			this.textRequests.set(reqId, pages => { clearTimeout(timer); resolve(pages); });
			this.post(entry, { type: 'pdfExtractText', reqId });
		});
	}

	suggest(uri: vscodeTypes.Uri, items: PdfSuggestion[]): void {
		const entry = this.open.get(uri.toString());
		if (entry) {
			this.post(entry, { type: 'pdfSuggest', items });
		}
	}
	private lastTextEditor: vscodeTypes.TextEditor | undefined;

	constructor(private readonly vscode: typeof vscodeTypes, private readonly deps: PdfReaderDeps) {}

	trackEditor(editor: vscodeTypes.TextEditor | undefined): void {
		if (editor && ['file', 'untitled'].includes(editor.document.uri.scheme ?? 'file')) {
			this.lastTextEditor = editor;
		}
	}

	workspaceDirFor(uri: vscodeTypes.Uri): string | undefined {
		const folders = this.vscode.workspace.workspaceFolders ?? [];
		const inside = folders.find(f => !path.relative(f.uri.fsPath, uri.fsPath).startsWith('..'));
		return (inside ?? folders[0])?.uri.fsPath;
	}

	notesFileFor(uri: vscodeTypes.Uri): string {
		return annotationsPath(uri.fsPath, this.workspaceDirFor(uri), this.deps.globalStorageDir);
	}

	openCustomDocument(uri: vscodeTypes.Uri): vscodeTypes.CustomDocument {
		return { uri, dispose: () => undefined };
	}

	resolveCustomEditor(document: vscodeTypes.CustomDocument, panel: vscodeTypes.WebviewPanel): void {
		const { vscode } = this;
		const uri = document.uri;
		const id = uri.toString();
		const workspaceDir = this.workspaceDirFor(uri);
		const entry: OpenPdf = { panel, notesFile: this.notesFileFor(uri), key: pdfKey(uri.fsPath, workspaceDir) };
		this.open.set(id, entry);

		// The PDF's own folder must be a resource root, or asWebviewUri(document.uri)
		// cannot be fetched by PDF.js inside the webview.
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				this.deps.extensionUri,
				vscode.Uri.joinPath(uri, '..'),
				...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri),
			],
		};
		panel.webview.html = this.html(panel.webview);
		panel.webview.onDidReceiveMessage(raw => this.handle(uri, raw));
		panel.onDidDispose(() => {
			if (this.open.get(id) === entry) {
				this.open.delete(id);
			}
		});
	}

	html(webview: vscodeTypes.Webview): string {
		const media = this.vscode.Uri.joinPath(this.deps.extensionUri, 'media');
		const file = this.vscode.Uri.joinPath(media, PDF_TEMPLATE).fsPath;
		if (!fs.existsSync(file)) {
			return MISSING_TEMPLATE;
		}
		const asUri = (...parts: string[]) => webview.asWebviewUri(this.vscode.Uri.joinPath(media, ...parts)).toString();
		return fillTemplate(fs.readFileSync(file, 'utf8'), {
			'{{CSP_SOURCE}}': webview.cspSource,
			'{{NONCE}}': crypto.randomBytes(16).toString('hex'),
			'{{PDF_CSS_URI}}': asUri('pdf.css'),
			'{{PDF_JS_URI}}': asUri('vendor', 'pdf.min.mjs'),
			'{{PDF_WORKER_URI}}': asUri('vendor', 'pdf.worker.min.mjs'),
			'{{PDF_APP_URI}}': asUri('pdf.js'),
		});
	}

	// Jumps an open reader to `page`, or remembers it for the reader about to open.
	goToPage(uri: vscodeTypes.Uri, page: number): void {
		if (!isPage(page)) {
			return;
		}
		const entry = this.open.get(uri.toString());
		if (entry) {
			this.post(entry, { type: 'pdfGoToPage', page });
		} else {
			this.pendingPage.set(uri.toString(), page);
		}
	}

	private post(entry: OpenPdf, message: PdfHostToWebview): void {
		entry.panel.webview.postMessage(message);
	}

	private load(entry: OpenPdf): PdfAnnotations {
		return loadPdfAnnotations(entry.notesFile, entry.key);
	}

	// Reads the file fresh before each change, so a hand edit or a second
	// window is never overwritten with stale data.
	private mutate(entry: OpenPdf, change: (data: PdfAnnotations) => PdfAnnotations): void {
		const before = this.load(entry);
		const after = change(before);
		if (after !== before) {
			savePdfAnnotations(entry.notesFile, after);
		}
		this.post(entry, { type: 'pdfData', highlights: after.highlights, bookmarks: after.bookmarks });
	}

	async handle(uri: vscodeTypes.Uri, raw: unknown): Promise<void> {
		const entry = this.open.get(uri.toString());
		const msg = parsePdfMessage(raw);
		if (!entry || !msg) {
			return;
		}
		// The host knows which file is open; the webview's fileName is not trusted.
		const fileName = path.basename(uri.fsPath);
		switch (msg.type) {
			case 'pdfText': {
				this.textRequests.get(msg.reqId)?.(msg.pages);
				this.textRequests.delete(msg.reqId);
				break;
			}
			case 'pdfReady': {
				const data = this.load(entry);
				const initialPage = this.pendingPage.get(uri.toString());
				this.pendingPage.delete(uri.toString());
				this.post(entry, {
					type: 'pdfInit',
					fileName,
					pdfUri: entry.panel.webview.asWebviewUri(uri).toString(),
					highlights: data.highlights,
					bookmarks: data.bookmarks,
					...(initialPage ? { initialPage } : {}),
				});
				break;
			}
			case 'addHighlight':
				this.mutate(entry, d => addHighlight(d, msg.highlight));
				break;
			case 'deleteHighlight':
				this.mutate(entry, d => deleteHighlight(d, msg.id));
				break;
			case 'updateHighlightNote':
				this.mutate(entry, d => updateHighlightNote(d, msg.id, msg.note));
				break;
			case 'toggleBookmark':
				this.mutate(entry, d => toggleBookmark(d, msg.page, msg.label));
				break;
			case 'deleteBookmark':
				this.mutate(entry, d => deleteBookmark(d, msg.id));
				break;
			case 'sendToDraft':
				await this.sendToDraft(formatQuoteForDraft(msg.text, msg.page, fileName));
				break;
			case 'appendToSourceMap':
				this.appendToSourceMap(uri, msg.text, msg.page, fileName);
				break;
		}
	}

	// The studio's draft first, then any visible Markdown editor, then the
	// most recent visible text editor. Hidden editors cannot be edited.
	findDraft(): vscodeTypes.TextEditor | undefined {
		const visible = this.vscode.window.visibleTextEditors ?? [];
		const draft = this.deps.draftEditor();
		if (draft && !draft.document.isClosed) {
			return draft;
		}
		const markdown = visible.find(e => e.document.languageId === 'markdown');
		if (markdown) {
			return markdown;
		}
		const last = this.lastTextEditor;
		return last && !last.document.isClosed && visible.includes(last) ? last : visible.find(e => e.document.uri.scheme === 'file');
	}

	async sendToDraft(quote: string): Promise<boolean> {
		const { vscode } = this;
		let editor = this.findDraft();
		if (editor && !(vscode.window.visibleTextEditors ?? []).includes(editor)) {
			editor = await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: true, preview: false });
		}
		if (editor) {
			const sel = editor.selection;
			const line = editor.document.lineAt(sel.start.line).text;
			const endLine = editor.document.lineAt(sel.end.line).text;
			const text = padQuote(quote, line.slice(0, sel.start.character), endLine.slice(sel.end.character));
			const done = await editor.edit(b => b.replace(sel, text));
			if (done) {
				editor.revealRange(sel, vscode.TextEditorRevealType.InCenter);
				vscode.window.setStatusBarMessage(`VSwriter: quote added to ${path.basename(editor.document.fileName)}`, 4000);
				return true;
			}
		}
		await vscode.env.clipboard.writeText(quote);
		vscode.window.showInformationMessage('VSwriter: no Markdown draft is open, so the quote and its citation are on the clipboard.');
		return false;
	}

	appendToSourceMap(uri: vscodeTypes.Uri, text: string, page: number, fileName: string): void {
		const { vscode } = this;
		const workspaceDir = this.workspaceDirFor(uri);
		if (!workspaceDir) {
			vscode.window.showWarningMessage('VSwriter: open the assignment folder first. source-map.md is kept there.');
			return;
		}
		appendHighlightToSourceMap(workspaceDir, text, page, fileName);
		vscode.window.setStatusBarMessage(`VSwriter: PDF p. ${page} added to source-map.md`, 4000);
		this.deps.onSourceMapChanged?.();
	}
}

// ---------------------------------------------------------------------------
// Registration and the Open PDF Beside Draft command

const PDF_EXCLUDE = '{**/node_modules/**,**/.git/**,**/.vswriter/**}';

export async function pickPdf(vscode: typeof vscodeTypes): Promise<vscodeTypes.Uri | undefined> {
	const browse = async () => (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { PDF: ['pdf'] }, openLabel: 'Open beside draft' }))?.[0];
	const found = vscode.workspace.workspaceFolders?.length ? await vscode.workspace.findFiles('**/*.pdf', PDF_EXCLUDE, 2000) : [];
	if (!found.length) {
		return browse();
	}
	const items = [
		{ label: 'Browse for a PDF...', uri: undefined as vscodeTypes.Uri | undefined },
		...found
			.map(uri => ({ label: path.basename(uri.fsPath), description: path.dirname(vscode.workspace.asRelativePath(uri, false)), uri }))
			.sort((a, b) => a.label.localeCompare(b.label)),
	];
	const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Open a PDF beside the draft', matchOnDescription: true });
	if (!pick) {
		return undefined;
	}
	return pick.uri ?? browse();
}

export async function openPdfBeside(vscode: typeof vscodeTypes, provider: PdfReaderProvider, uri?: unknown, page?: unknown): Promise<void> {
	const target = uri && typeof (uri as vscodeTypes.Uri).fsPath === 'string' ? (uri as vscodeTypes.Uri) : await pickPdf(vscode);
	if (!target) {
		return;
	}
	if (isPage(page)) {
		provider.goToPage(target, page);
	}
	await vscode.commands.executeCommand('vscode.openWith', target, PDF_VIEW_TYPE, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false });
}

export function registerPdfReader(vscode: typeof vscodeTypes, deps: PdfReaderDeps): { provider: PdfReaderProvider; disposables: vscodeTypes.Disposable[] } {
	const provider = new PdfReaderProvider(vscode, deps);
	provider.trackEditor(vscode.window.activeTextEditor);
	return {
		provider,
		disposables: [
			vscode.window.registerCustomEditorProvider(PDF_VIEW_TYPE, provider, {
				// Scroll position and rendered pages survive switching tabs.
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: false,
			}),
			vscode.commands.registerCommand('writerStudio.openPdfBeside', (uri?: unknown, page?: unknown) => openPdfBeside(vscode, provider, uri, page)),
			vscode.window.onDidChangeActiveTextEditor(e => provider.trackEditor(e)),
		],
	};
}
