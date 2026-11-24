// Nudges: when the writer stalls on a paragraph, VSwriter raises one or two
// speech bubbles beside it, drawn from their own interview and mind map. A
// bubble either recalls something they said (quoted exactly, checked against
// the saved answers) or raises a question. It never writes sentences for them.
// Bubbles are comment threads, so they wrap, sit under the paragraph and take
// a reply, which is saved to the interview like any other answer.

import * as fs from 'fs';
import * as path from 'path';
import type * as vscodeTypes from 'vscode';
import { AssistantState, ChatTurn, Draft, draftExcerpt, extractJson } from './assistant';

export interface Bubble {
	kind: 'recall' | 'raise';
	text: string;
	quote?: string; // recall only: the writer's own words, verbatim
}

export function buildNudgePrompt(state: AssistantState, history: ChatTurn[], mindMap: string, draft: Draft): string {
	const talk = history.map(t => `${t.role === 'writer' ? 'WRITER' : 'ASSISTANT'}: ${t.text}`).join('\n\n');
	return [
		'A writer has stalled on the paragraph marked >>> in their draft. Give them one or two short speech bubbles to get them moving again.',
		'Each bubble is one of:',
		'- recall: remind them of something THEY said in the interview that bears on this paragraph. Put their exact words in "quote", copied character for character from a WRITER line, and say in a few words why it fits here.',
		'- raise: one question that opens the next step for this paragraph: its point, an example, their reading of the evidence, or the link to the next idea. Use the mind map to see what is still unwritten.',
		'Rules: under 35 words per bubble. Plain words. Never write a sentence for their essay or suggest wording. Prefer recall when their own words fit.',
		'Return ONLY JSON: {"bubbles": [{"kind": "recall" or "raise", "text": "...", "quote": "..."}]}',
		'',
		`BRIEF:\n${state.brief || '(not defined)'}`,
		'',
		`INTERVIEW:\n${talk || '(none yet)'}`,
		'',
		`MIND MAP:\n${mindMap || '(none yet)'}`,
		'',
		`DRAFT (${draft.name}):\n${draftExcerpt(draft)}`,
	].join('\n');
}

const squash = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

type Raw = { bubbles: unknown[] };
const isRaw = (v: unknown): v is Raw => !!v && Array.isArray((v as Raw).bubbles);

/** Bubbles from model output. A recall whose quote is not in the writer's own answers is dropped. */
export function parseNudge(raw: string, writerAnswers: string[]): Bubble[] {
	const j = extractJson(raw, isRaw);
	if (!j) return [];
	const said = squash(writerAnswers.join('\n'));
	const out: Bubble[] = [];
	for (const b of j.bubbles) {
		const { kind, text, quote } = (b ?? {}) as Record<string, unknown>;
		if (typeof text !== 'string' || !text.trim()) continue;
		if (kind === 'recall') {
			if (typeof quote !== 'string' || quote.trim().length < 4 || !said.includes(squash(quote))) continue;
			out.push({ kind, text: text.trim(), quote: quote.trim() });
		} else if (kind === 'raise') {
			out.push({ kind, text: text.trim() });
		}
	}
	return out.slice(0, 2);
}

export function bubbleMarkdown(b: Bubble): string {
	return b.kind === 'recall' ? `You said: *"${b.quote}"*\n\n${b.text}` : b.text;
}

export function readMindMap(root: string): string {
	try {
		return fs.readFileSync(path.join(root, 'mind-map.md'), 'utf8').match(/```mermaid\n([\s\S]*?)```/)?.[1].trim() ?? '';
	} catch {
		return '';
	}
}

export interface NudgeHost {
	isDraft(doc: vscodeTypes.TextDocument): boolean;
	/** Interview context, or null when there is no workspace to draw from. */
	context(): { root: string; state: AssistantState; history: ChatTurn[]; answers: string[] } | null;
	ask(prompt: string): Promise<string>;
	/** Saves a reply typed into a bubble as an interview answer to that bubble. */
	saveReply(bubble: string, reply: string): void;
	stuckSeconds(): number; // 0 turns automatic nudges off
	log(line: string): void;
}

const COOLDOWN_MS = 120_000;
const STALE_MS = 300_000;

export function registerNudges(vscode: typeof vscodeTypes, host: NudgeHost): vscodeTypes.Disposable[] {
	const controller = vscode.comments.createCommentController('writerStudio.nudge', 'VSwriter');
	controller.options = { prompt: 'Answer in your own words…', placeHolder: 'Rough is fine. Saved to your interview.' };
	const threads = new Set<vscodeTypes.CommentThread>();
	let lastEdit = 0;
	let lastNudge = 0;
	let nudged = new Set<string>(); // paragraphs (by text) already nudged as they stand
	let busy = false;

	const author = { name: 'VSwriter ✦' };
	const comment = (body: string, name = author.name): vscodeTypes.Comment => ({
		body: new vscode.MarkdownString(body),
		mode: vscode.CommentMode.Preview,
		author: { name },
	});
	const clearAll = () => {
		for (const t of threads) t.dispose();
		threads.clear();
	};

	const paragraphEnd = (doc: vscodeTypes.TextDocument, line: number) => {
		let b = line;
		while (b < doc.lineCount - 1 && doc.lineAt(b + 1).text.trim()) b++;
		return b;
	};
	const paragraphText = (doc: vscodeTypes.TextDocument, line: number) => {
		let a = line;
		while (a > 0 && doc.lineAt(a - 1).text.trim()) a--;
		return doc.getText(new vscode.Range(a, 0, paragraphEnd(doc, line), 1e6));
	};

	const nudge = async (editor: vscodeTypes.TextEditor, manual: boolean) => {
		if (busy) return;
		const ctx = host.context();
		if (!ctx) {
			if (manual) void vscode.window.showInformationMessage('VSwriter: open a writing folder first.');
			return;
		}
		const doc = editor.document;
		const line = editor.selection.active.line;
		const key = paragraphText(doc, line);
		busy = true;
		lastNudge = Date.now();
		nudged.add(key);
		try {
			const draft: Draft = { name: path.basename(doc.fileName), text: doc.getText(), line };
			const prompt = buildNudgePrompt(ctx.state, ctx.history, readMindMap(ctx.root), draft);
			const bubbles = parseNudge(await host.ask(prompt), ctx.answers);
			host.log(`nudge: ${bubbles.map(b => b.kind).join(', ') || 'nothing usable'}${manual ? ' (asked)' : ''}`);
			if (!bubbles.length) {
				if (manual) void vscode.window.showInformationMessage('VSwriter: no nudge came back. Try again in a moment.');
				return;
			}
			// The writer may have moved on while the model thought.
			if (!manual && Date.now() - lastEdit < 3000) return;
			clearAll();
			const end = paragraphEnd(doc, line);
			const endCol = doc.lineAt(end).text.length; // after the last word, so a wrapped paragraph stays whole
			for (const b of bubbles) {
				const thread = controller.createCommentThread(doc.uri, new vscode.Range(end, endCol, end, endCol), [comment(bubbleMarkdown(b))]);
				thread.label = b.kind === 'recall' ? 'From your interview' : 'Something to think about';
				thread.canReply = true;
				thread.contextValue = 'writerStudio.nudge';
				thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
				threads.add(thread);
			}
		} catch (err) {
			host.log(`nudge: ${(err as Error).message}`);
		} finally {
			busy = false;
		}
	};

	// Stuck: the writer was writing in the last few minutes, then nothing has
	// changed for stuckSeconds, and this paragraph as it stands has not been
	// nudged before. Someone who walked away long ago is not stuck.
	const timer = setInterval(() => {
		const seconds = host.stuckSeconds();
		const editor = vscode.window.activeTextEditor;
		if (!seconds || !editor || !host.isDraft(editor.document)) return;
		const now = Date.now();
		if (!lastEdit || now - lastEdit < seconds * 1000 || now - lastEdit > STALE_MS || now - lastNudge < COOLDOWN_MS || threads.size) return;
		if (nudged.has(paragraphText(editor.document, editor.selection.active.line))) return;
		void nudge(editor, false);
	}, 5000);
	(timer as { unref?: () => void }).unref?.(); // never keeps a host or test process alive

	return [
		controller,
		{ dispose: () => { clearInterval(timer); clearAll(); } },
		vscode.workspace.onDidChangeTextDocument(e => {
			if (!e.contentChanges.length || !host.isDraft(e.document)) return;
			lastEdit = Date.now();
			// Bubbles are for the stall; once the writer is moving they go.
			if (threads.size && [...threads].some(t => t.uri.toString() === e.document.uri.toString() && !t.comments.some(c => c.author.name !== author.name))) clearAll();
		}),
		vscode.workspace.onDidOpenTextDocument(() => { nudged = new Set(); }),
		vscode.commands.registerCommand('writerStudio.nudge', () => {
			const editor = vscode.window.activeTextEditor;
			if (editor) void nudge(editor, true);
		}),
		vscode.commands.registerCommand('writerStudio.nudge.reply', (reply: vscodeTypes.CommentReply) => {
			const text = reply.text.trim();
			if (!text) return;
			const asked = reply.thread.comments[0]?.body;
			host.saveReply(typeof asked === 'string' ? asked : asked?.value ?? '', text);
			reply.thread.comments = [...reply.thread.comments, comment(text, 'You'), comment('Saved to your interview. Keep going.')];
			reply.thread.canReply = false;
		}),
		vscode.commands.registerCommand('writerStudio.nudge.dismiss', (thread?: vscodeTypes.CommentThread) => {
			if (thread) {
				thread.dispose();
				threads.delete(thread);
			} else {
				clearAll();
			}
		}),
	];
}
