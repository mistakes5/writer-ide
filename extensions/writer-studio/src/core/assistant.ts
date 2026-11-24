// The writing assistant: a chat that first defines what the writer is writing
// (the brief), then interviews them one question at a time from the brief,
// their own earlier answers and the draft they are actually writing.
//
// Storage stays in the plain workflow files. Each reply the writer sends is
// appended verbatim to raw-answers.md with the question it answered; the brief,
// the phase and the question now on the table live in one marked block of
// interview-state.md, so the rest of that file is the writer's own.

import * as fs from 'fs';
import { INTERVIEW_STATE, WorkflowStore } from './workflowStore';

export type Phase = 'define' | 'interview';

export interface ChatTurn {
	role: 'assistant' | 'writer';
	text: string;
}

export interface AssistantState {
	phase: Phase;
	brief: string; // markdown bullets, empty until the piece is defined
	question: string; // the assistant message waiting for an answer
}

export interface Draft {
	name: string;
	text: string;
	line: number; // 0-based cursor line
}

export const OPENING = 'What are you writing? Tell me in a sentence or two, and paste the assignment prompt if there is one.';

const START = '<!-- vswriter-assistant:start -->';
const END = '<!-- vswriter-assistant:end -->';
const HISTORY_TURNS = 12;
const DRAFT_CHARS = 8000;

export function readState(store: WorkflowStore): AssistantState {
	let text = '';
	try {
		text = fs.readFileSync(store.file(INTERVIEW_STATE), 'utf8');
	} catch {
		// no state yet
	}
	const block = text.includes(START) ? text.slice(text.indexOf(START), text.indexOf(END)) : '';
	const section = (name: string) => block.match(new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`))?.[1].trim() ?? '';
	const phase = section('Phase') === 'interview' ? 'interview' : 'define';
	return { phase, brief: section('Brief'), question: section('Current question') || OPENING };
}

export function writeState(store: WorkflowStore, s: AssistantState): void {
	const file = store.file(INTERVIEW_STATE);
	const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Interview state\n';
	const block = `${START}\n## Phase\n${s.phase}\n\n## Brief\n${s.brief || '(not defined yet)'}\n\n## Current question\n${s.question}\n${END}`;
	const next = old.includes(START) && old.includes(END)
		? old.slice(0, old.indexOf(START)) + block + old.slice(old.indexOf(END) + END.length)
		: `${old.trimEnd()}\n\n${block}\n`;
	fs.writeFileSync(file, next, 'utf8');
}

/** The conversation so far: every saved answer under its question, then the open question. */
export function transcript(store: WorkflowStore, state: AssistantState): ChatTurn[] {
	const turns: ChatTurn[] = [];
	for (const a of store.readAnswers()) {
		if (a.prompt) turns.push({ role: 'assistant', text: a.prompt });
		turns.push({ role: 'writer', text: a.text });
	}
	turns.push({ role: 'assistant', text: state.question });
	return turns;
}

/** The draft with the paragraph under the cursor marked, trimmed around it. */
export function draftExcerpt(draft: Draft | null): string {
	if (!draft || !draft.text.trim()) return '(no draft written yet)';
	const lines = draft.text.split(/\r?\n/);
	lines[draft.line] = `>>> ${lines[draft.line] ?? ''}`;
	const text = lines.join('\n');
	if (text.length <= DRAFT_CHARS) return text;
	const at = text.indexOf('>>> ');
	const from = Math.max(0, Math.min(at - DRAFT_CHARS / 2, text.length - DRAFT_CHARS));
	return `…${text.slice(from, from + DRAFT_CHARS)}…`;
}

export function buildPrompt(state: AssistantState, history: ChatTurn[], draft: Draft | null, readings: string[]): string {
	const talk = history.slice(-HISTORY_TURNS).map(t => `${t.role === 'writer' ? 'WRITER' : 'YOU'}: ${t.text}`).join('\n\n');
	return [
		'You are the writing assistant inside VSwriter, an editor for essays. You help a writer think and write in their own words. You never write their sentences or paragraphs for them.',
		'',
		'Work in two phases.',
		'DEFINE: learn what they are writing before anything else. In order of importance: the kind of piece and its prompt, what they think so far (their tentative answer), the readings they must use, the length. Ask about the reader or due date only when it changes the writing. Ask only for what is still missing; use what the draft and file list already show. As soon as you know the piece, the prompt and their tentative answer, write the brief and move to INTERVIEW.',
		'INTERVIEW: read the draft, especially the paragraph marked >>> (where the cursor is). Ask the single question that fills the most important gap in what they are writing now: the point of the paragraph, the evidence or example, their own interpretation, or how it connects to the argument. Quote their words back when it helps. Name a specific reading when it bears on the question. If a paragraph has what it needs, say so briefly and move to the next one.',
		'',
		'When every paragraph the essay needs has its point, evidence and their interpretation, say the interview is done and suggest the Mind map button above the chat.',
		'Rules: exactly one question per message, never two joined together. Plain words. Under 70 words. Acknowledge their answer in a short clause first when it adds something. Never draft text for them.',
		'',
		'Return ONLY JSON: {"reply": "<your message>", "phase": "define" or "interview", "brief": "<3-6 markdown bullets defining the piece, or empty string if unchanged>"}',
		'',
		`PHASE NOW: ${state.phase}`,
		`BRIEF: ${state.brief || '(not defined yet)'}`,
		`READINGS IN THE FOLDER: ${readings.length ? readings.join('; ') : '(none)'}`,
		'',
		`CONVERSATION:\n${talk}`,
		'',
		`DRAFT${draft ? ` (${draft.name})` : ''}:\n${draftExcerpt(draft)}`,
	].join('\n');
}

/**
 * The first JSON object in a model's output that `accept` takes. Models add
 * chatter and code fences around JSON, and braces can appear in that chatter,
 * so each opening brace is tried against each closing brace from the end.
 */
export function extractJson<T>(raw: string, accept: (v: unknown) => v is T): T | null {
	const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1]);
	for (const text of [...fenced, raw]) {
		const ends: number[] = [];
		for (let i = text.length - 1; i >= 0; i--) if (text[i] === '}') ends.push(i);
		for (let a = text.indexOf('{'); a >= 0; a = text.indexOf('{', a + 1)) {
			for (const b of ends) {
				if (b <= a) break;
				try {
					const v = JSON.parse(text.slice(a, b + 1));
					if (accept(v)) return v;
				} catch {
					// not this pair
				}
			}
		}
	}
	return null;
}

type Reply = { reply: string; phase?: unknown; brief?: unknown };
const isReply = (v: unknown): v is Reply => !!v && typeof (v as Reply).reply === 'string' && (v as Reply).reply.trim() !== '';

export function parseReply(raw: string, state: AssistantState): AssistantState | null {
	const j = extractJson(raw, isReply);
	if (!j) return null;
	const brief = typeof j.brief === 'string' && j.brief.trim() ? j.brief.trim() : state.brief;
	return { phase: j.phase === 'interview' ? 'interview' : state.phase, brief, question: j.reply.trim() };
}

/** Saves the writer's message, asks the model for the next move and stores it. */
export async function respond(
	store: WorkflowStore,
	text: string,
	draft: Draft | null,
	readings: string[],
	ask: (prompt: string) => Promise<string>,
): Promise<AssistantState> {
	store.init();
	const state = readState(store);
	store.appendAnswer(state.question, text);
	const raw = await ask(buildPrompt(state, transcript(store, state).slice(0, -1), draft, readings));
	const next = parseReply(raw, state);
	if (!next) throw new Error(`the assistant's reply could not be read: ${raw.slice(0, 200)}`);
	writeState(store, next);
	return next;
}


// ---- mind map -----------------------------------------------------------

export function buildMindMapPrompt(state: AssistantState, history: ChatTurn[], draft: Draft | null): string {
	const talk = history.map(t => `${t.role === 'writer' ? 'WRITER' : 'ASSISTANT'}: ${t.text}`).join('\n\n');
	return [
		'Turn this writer\'s interview into a mind map of their essay, in Mermaid mindmap syntax.',
		'Root: the essay\'s question in a few words. First branches: their answer to it and each main idea. Under each idea: the evidence they named (reading and page when given) and their own interpretation.',
		'Use the writer\'s own words wherever possible. At most 8 words per node. Plain text only in nodes: no brackets, parentheses or quotation marks. Indent with two spaces per level.',
		'Return ONLY the Mermaid code, starting with the line: mindmap',
		'',
		`BRIEF:\n${state.brief || '(not defined)'}`,
		'',
		`INTERVIEW:\n${talk}`,
		'',
		`DRAFT:\n${draftExcerpt(draft)}`,
	].join('\n');
}

/** Mermaid mindmap code from model output, with node text cleaned of shape syntax. */
export function parseMindMap(raw: string): string | null {
	const body = raw.match(/```(?:mermaid)?\s*([\s\S]*?)```/)?.[1] ?? raw;
	const lines = body.split('\n');
	const start = lines.findIndex(l => l.trim() === 'mindmap');
	if (start < 0) return null;
	const nodes = lines.slice(start + 1).filter(l => l.trim()).map(l => {
		const indent = l.match(/^\s*/)![0];
		return indent + l.trim().replace(/^root\s*/, '').replace(/[()[\]{}"]/g, '').replace(/^[-*]\s*/, '');
	}).filter(l => l.trim());
	return nodes.length >= 2 ? ['mindmap', ...nodes].join('\n') : null;
}
