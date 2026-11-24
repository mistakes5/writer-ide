// Companion: while a writer drafts beside a PDF, notice when a paragraph is
// developing an idea, then offer passages from that PDF that support or
// complicate it. Jev (TypeSafe System One) decides whether the paragraph is
// worth a search; a Claude model proposes passages; every quote is checked
// verbatim against the page text before the writer sees it.

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscodeTypes from 'vscode';
import type { PdfSuggestion } from '../shared/pdfProtocol';
import type { PdfReaderProvider } from './pdfEditor';

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-1.14.0';
const MIN_WORDS = 15;
const MAX_CHARS = 90_000; // page text sent to the model

export interface CompanionDeps {
	pdf: PdfReaderProvider;
	isDraft: (doc: vscodeTypes.TextDocument) => boolean;
	log: (line: string) => void;
}

/** The blank-line-delimited paragraph around a line. */
export function paragraphAt(text: string, line: number): string {
	const lines = text.split(/\r?\n/);
	let start = line;
	let end = line;
	while (start > 0 && lines[start - 1].trim()) start--;
	while (end < lines.length - 1 && lines[end + 1].trim()) end++;
	return lines.slice(start, end + 1).join(' ').trim();
}

/** Folding used for the verbatim check: quotes, dashes, case, whitespace. */
export function fold(s: string): string {
	return s
		.replace(/[‘’‚′]/g, "'")
		.replace(/[“”„″]/g, '"')
		.replace(/[‐‑–—]/g, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

/** Keep only quotes found word for word in the PDF, moved to the page they are on. */
export function verify(items: PdfSuggestion[], pages: string[]): PdfSuggestion[] {
	const folded = pages.map(fold);
	const out: PdfSuggestion[] = [];
	for (const item of items) {
		const q = fold(item.quote).replace(/^["'.,\s]+|["'.,\s]+$/g, '');
		if (q.split(' ').length < 4) continue;
		const at = folded[item.page - 1]?.includes(q) ? item.page - 1 : folded.findIndex(p => p.includes(q));
		if (at >= 0) out.push({ ...item, page: at + 1 });
	}
	return out;
}

/** Parse the model's JSON array, tolerating a fenced block or surrounding prose. */
export function parseSuggestions(raw: string): PdfSuggestion[] {
	const m = raw.match(/\[[\s\S]*\]/);
	if (!m) return [];
	try {
		const arr = JSON.parse(m[0]);
		return (Array.isArray(arr) ? arr : [])
			.filter(x => x && typeof x.quote === 'string' && Number.isInteger(x.page))
			.map(x => ({
				page: x.page,
				quote: x.quote.trim(),
				stance: x.stance === 'complicates' ? 'complicates' : 'supports',
				why: typeof x.why === 'string' ? x.why.trim() : '',
			}));
	} catch {
		return [];
	}
}

export function buildPrompt(paragraph: string, fileName: string, pages: string[]): string {
	let body = '';
	for (let i = 0; i < pages.length && body.length < MAX_CHARS; i++) {
		body += `\n[[PDF PAGE ${i + 1}]]\n${pages[i]}\n`;
	}
	return [
		'A writer is drafting the paragraph below with the reading beside it.',
		'Find up to 4 passages in the reading that bear on what the paragraph argues: 2 or 3 that support it and at least 1 that complicates, qualifies or challenges it, if the reading has one.',
		'Copy each quote exactly as it appears in the page text, 8 to 40 words, from a single page. Never paraphrase inside a quote.',
		'Return ONLY a JSON array: [{"page": <PDF PAGE number>, "quote": "...", "stance": "supports" | "complicates", "why": "<one plain sentence on how it bears on the paragraph>"}]',
		'',
		`PARAGRAPH:\n${paragraph}`,
		'',
		`READING (${fileName}):${body}`,
	].join('\n');
}

function run(cmd: string, args: string[], input: string | undefined, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin:${os.homedir()}/.local/bin:${os.homedir()}/.bun/bin` } }, (err, stdout, stderr) =>
			err ? reject(new Error(stderr?.toString().slice(0, 300) || err.message)) : resolve(stdout.toString()));
		// Always close stdin: CLIs in print mode wait for EOF when it is a pipe.
		child.stdin?.end(input ?? '');
	});
}

let cachedKey: string | null | undefined;
async function typesafeKey(): Promise<string | null> {
	if (cachedKey !== undefined) return cachedKey;
	if (process.env.TYPESAFE_API_KEY) return (cachedKey = process.env.TYPESAFE_API_KEY);
	try {
		cachedKey = (await run('/usr/bin/security', ['find-generic-password', '-a', os.userInfo().username, '-s', 'TYPESAFE_API_KEY', '-w'], undefined, 8000)).trim() || null;
	} catch {
		cachedKey = null;
	}
	return cachedKey;
}

/** Jev's probability that the paragraph develops an idea sources could bear on; null when Jev is unavailable. */
export async function ideaProbability(paragraph: string): Promise<number | null> {
	const key = await typesafeKey();
	if (!key) return null;
	const body = {
		model: JEV_MODEL,
		state: { draft: { paragraph } },
		questions: {
			idea: {
				type: 'choice',
				instructions: 'Does `draft.paragraph` develop an idea, argument or claim that a course reading could support, complicate or challenge? Notes to self, headings, logistics and plain statements of what the writer will do are not.',
				criteria: { idea: 'Develops an idea, argument or claim that sources could bear on', other: 'Heading, note to self, logistics or no arguable content' },
			},
		},
	};
	const res = await fetch(JEV_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
	if (!res.ok) throw new Error(`Jev ${res.status}`);
	const json = (await res.json()) as { answers?: { idea?: { probabilities?: Record<string, number> } } };
	return json.answers?.idea?.probabilities?.idea ?? null;
}

function claudeBinary(): string {
	const candidates = [path.join(os.homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
	return candidates.find(c => fs.existsSync(c)) ?? 'claude';
}

/**
 * One prompt to Claude: the native claude CLI in bare print mode (no tools,
 * MCP servers, slash commands or settings, so it costs only the prompt and runs
 * on the writer's own Claude login), then OMP's subscription route when that
 * output is unusable (for example the CLI is not logged in). `usable` decides.
 */
export async function askClaude(model: string, prompt: string, usable: (out: string) => boolean): Promise<string> {
	let out = await run(claudeBinary(), ['-p', '--model', model, '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', ''], prompt, 180000).catch(e => String(e.message));
	const omp = path.join(os.homedir(), '.bun/bin/omp');
	if (!usable(out) && fs.existsSync(omp)) {
		out = await run(omp, ['-p', prompt, '--model', `anthropic/${model}`, '--no-tools', '--thinking', 'off', '--system-prompt', 'Answer exactly in the format requested.'], undefined, 180000);
	}
	return out;
}

export async function findPassages(model: string, prompt: string): Promise<{ items: PdfSuggestion[]; raw: string }> {
	const out = await askClaude(model, prompt, o => /\[[\s\S]*\]/.test(o));
	return { items: parseSuggestions(out), raw: out };
}

export class Companion implements vscodeTypes.Disposable {
	private timer: NodeJS.Timeout | undefined;
	private readonly seen = new Map<string, PdfSuggestion[]>(); // paragraph+pdf hash -> verified passages
	private readonly texts = new Map<string, string[]>(); // pdf uri -> page texts
	private readonly status: vscodeTypes.StatusBarItem;
	private readonly subs: vscodeTypes.Disposable[] = [];
	private running = 0;

	constructor(private readonly vscode: typeof vscodeTypes, private readonly deps: CompanionDeps) {
		this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.subs.push(
			this.status,
			vscode.workspace.onDidChangeTextDocument(e => this.schedule(e.document)),
			vscode.window.onDidChangeActiveTextEditor(e => e && void this.openReadingBeside(e.document)),
			// A PDF dropped onto the draft (or opened over it) moves beside it.
			vscode.window.tabGroups.onDidChangeTabs(e => {
				// A draft opened again gets its reading beside it again; closing only the
				// reading keeps it closed while the draft stays open.
				for (const tab of e.closed) {
					const uri = (tab.input as { uri?: vscodeTypes.Uri } | undefined)?.uri;
					if (uri) this.besideDone.delete(uri.toString());
				}
				// A new tab is often marked active only in the change that follows its opening.
				for (const tab of [...e.opened, ...e.changed]) {
					const input = tab.input as { viewType?: string } | undefined;
					const overDraft = tab.group.tabs.some(t => (t.input as { uri?: vscodeTypes.Uri } | undefined)?.uri?.path.endsWith('.md') && !/\/(readings?|sources?)\//i.test((t.input as { uri: vscodeTypes.Uri }).uri.path));
					if (input?.viewType === 'writerStudio.pdfReader' && tab.isActive && overDraft) {
						void vscode.commands.executeCommand('workbench.action.moveEditorToRightGroup');
					}
				}
			}),
		);
		const first = vscode.window.activeTextEditor;
		if (first) void this.openReadingBeside(first.document);
	}

	private readonly besideDone = new Set<string>();

	/** Split screen by default: a draft opens with the newest workspace PDF beside it. */
	async openReadingBeside(doc: vscodeTypes.TextDocument): Promise<void> {
		const vscode = this.vscode;
		if (!vscode.workspace.getConfiguration('writerStudio').get<boolean>('splitScreenDefault', true) || !this.deps.isDraft(doc)) return;
		if (this.besideDone.has(doc.uri.toString()) || this.deps.pdf.openUris().length) return;
		this.besideDone.add(doc.uri.toString());
		const pdfs = await vscode.workspace.findFiles('**/*.pdf', '**/{node_modules,.git}/**', 50);
		const newest = pdfs.map(u => ({ u, t: fs.statSync(u.fsPath, { throwIfNoEntry: false })?.mtimeMs ?? 0 })).sort((a, b) => b.t - a.t)[0];
		if (newest) {
			await vscode.commands.executeCommand('vscode.openWith', newest.u, 'writerStudio.pdfReader', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
		}
	}

	private config() {
		return this.vscode.workspace.getConfiguration('writerStudio.companion');
	}

	private schedule(doc: vscodeTypes.TextDocument): void {
		if (!this.config().get<boolean>('enabled', true) || !this.deps.isDraft(doc)) return;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.check(doc), this.config().get<number>('pauseMs', 2500));
	}

	private say(text: string, tooltip?: string): void {
		this.status.text = text;
		this.status.tooltip = tooltip;
		text ? this.status.show() : this.status.hide();
	}

	async check(doc: vscodeTypes.TextDocument): Promise<void> {
		const editor = this.vscode.window.visibleTextEditors.find(e => e.document === doc);
		const pdfUri = this.deps.pdf.openUris()[0];
		if (!editor || !pdfUri) {
			if (editor) this.deps.log('companion: no PDF open beside the draft, skipping');
			return;
		}
		const paragraph = paragraphAt(doc.getText(), editor.selection.active.line);
		if (paragraph.split(/\s+/).length < MIN_WORDS || paragraph.startsWith('#')) return;
		const key = crypto.createHash('sha1').update(pdfUri.toString() + '\n' + paragraph).digest('hex');
		const cached = this.seen.get(key);
		if (cached) {
			this.deps.pdf.suggest(pdfUri, cached);
			return;
		}
		const seq = ++this.running;
		const fileName = path.basename(pdfUri.fsPath);
		try {
			this.say('$(loading~spin) VSwriter: reading your paragraph');
			const p = await ideaProbability(paragraph).catch(err => {
				this.deps.log(`companion: Jev unavailable (${err.message}); searching anyway`);
				return null;
			});
			const threshold = this.config().get<number>('ideaThreshold', 0.6);
			if (p !== null && p < threshold) {
				this.deps.log(`companion: Jev idea=${p.toFixed(2)} < ${threshold}, no search`);
				this.seen.set(key, []);
				if (seq === this.running) this.say('');
				return;
			}
			if (seq !== this.running) return;
			this.say(`$(loading~spin) VSwriter: finding passages in ${fileName}`, p === null ? 'Jev unavailable' : `Jev idea probability ${p.toFixed(2)}`);
			let pages = this.texts.get(pdfUri.toString());
			if (!pages?.some(t => t.trim())) {
				pages = await this.deps.pdf.extractText(pdfUri);
				this.texts.set(pdfUri.toString(), pages);
			}
			if (!pages.some(t => t.trim())) {
				this.say('VSwriter: this PDF has no selectable text');
				return;
			}
			const t0 = Date.now();
			const { items: proposed, raw } = await findPassages(this.config().get<string>('model', 'claude-sonnet-5-5'), buildPrompt(paragraph, fileName, pages));
			if (!proposed.length) this.deps.log(`companion: no passages parsed from model output: ${raw.slice(0, 400)}`);
			const verified = verify(proposed, pages);
			this.deps.log(`companion: idea=${p?.toFixed(2) ?? 'n/a'} proposed=${proposed.length} verified=${verified.length} in ${Date.now() - t0} ms`);
			this.seen.set(key, verified);
			if (seq !== this.running) return;
			this.deps.pdf.suggest(pdfUri, verified);
			this.say(verified.length ? `$(book) ${verified.length} passages in ${fileName}` : `VSwriter: no verified passages in ${fileName}`);
		} catch (err) {
			this.deps.log(`companion: ${(err as Error).message}`);
			if (seq === this.running) this.say('$(warning) VSwriter: passage search failed', (err as Error).message);
		}
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.subs.forEach(s => s.dispose());
	}
}
