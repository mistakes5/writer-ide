import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OPENING, buildPrompt, draftExcerpt, parseReply, readState, respond, transcript, writeState } from '../src/core/assistant';
import { WorkflowStore } from '../src/core/workflowStore';

const tmp = () => new WorkflowStore(fs.mkdtempSync(path.join(os.tmpdir(), 'vsw-')));

describe('assistant', () => {
	test('starts by asking what the writer is writing', () => {
		const s = readState(tmp());
		expect(s).toEqual({ phase: 'define', brief: '', question: OPENING });
	});

	test('state lives in one marked block and leaves the rest of the file alone', () => {
		const store = tmp();
		fs.writeFileSync(store.file('interview-state.md'), '# Interview state\n\nMy own notes.\n');
		writeState(store, { phase: 'interview', brief: '- essay on X', question: 'Why X?' });
		writeState(store, { phase: 'interview', brief: '- essay on Y', question: 'Why Y?' });
		const text = fs.readFileSync(store.file('interview-state.md'), 'utf8');
		expect(text).toContain('My own notes.');
		expect(text.match(/vswriter-assistant:start/g)).toHaveLength(1);
		expect(readState(store)).toEqual({ phase: 'interview', brief: '- essay on Y', question: 'Why Y?' });
	});

	test('a reply saves the answer verbatim under its question and stores the next question', async () => {
		const store = tmp();
		let sent = '';
		const next = await respond(store, 'An essay on  automated news.', { name: 'draft.md', text: 'First line\nSecond', line: 1 }, ['readings/Carlson.pdf'], async prompt => {
			sent = prompt;
			return '```json\n{"reply": "Who is it for?", "phase": "define", "brief": ""}\n```';
		});
		expect(next.question).toBe('Who is it for?');
		expect(store.readAnswers()[0]).toMatchObject({ prompt: OPENING, text: 'An essay on  automated news.' });
		expect(sent).toContain('>>> Second');
		expect(sent).toContain('readings/Carlson.pdf');
		expect(transcript(store, readState(store)).map(t => t.role)).toEqual(['assistant', 'writer', 'assistant']);
	});

	test('an unreadable reply keeps the state and reports it', async () => {
		const store = tmp();
		await expect(respond(store, 'hi', null, [], async () => 'Not logged in')).rejects.toThrow('could not be read');
		expect(readState(store).question).toBe(OPENING);
		expect(store.readAnswers()).toHaveLength(1);
	});

	test('parseReply keeps the old brief when none is given', () => {
		expect(parseReply('{"reply":"Q?","phase":"interview","brief":""}', { phase: 'define', brief: '- b', question: 'x' })).toEqual({ phase: 'interview', brief: '- b', question: 'Q?' });
		expect(parseReply('nope', { phase: 'define', brief: '', question: 'x' })).toBeNull();
		// The failure seen in the demo: chatter with braces, then a fenced reply.
		const chatter = 'That tool call {x} was not needed. Here is the reply:\n\n```json\n{\n  "reply": "You say authority (as craft) matters. Why?",\n  "phase": "interview",\n  "brief": ""\n}\n```\nDone {ok}';
		expect(parseReply(chatter, { phase: 'interview', brief: '- b', question: 'x' })?.question).toBe('You say authority (as craft) matters. Why?');
	});

	test('the prompt carries phase, brief and a marked draft', () => {
		const p = buildPrompt({ phase: 'interview', brief: '- essay', question: 'q' }, [{ role: 'writer', text: 'hello' }], { name: 'd.md', text: 'a\nb', line: 0 }, []);
		expect(p).toContain('PHASE NOW: interview');
		expect(p).toContain('WRITER: hello');
		expect(draftExcerpt(null)).toBe('(no draft written yet)');
	});
});

describe('mind map', () => {
	test('parses fenced mermaid and strips shape syntax from nodes', () => {
		const { parseMindMap } = require('../src/core/assistant');
		const raw = 'Here:\n```mermaid\nmindmap\n  root((Does automated news threaten authority?))\n    Yes, readers stop asking\n      "good enough" (Carlson p. 11)\n```';
		expect(parseMindMap(raw)).toBe('mindmap\n  Does automated news threaten authority?\n    Yes, readers stop asking\n      good enough Carlson p. 11');
		expect(parseMindMap('no map here')).toBeNull();
	});
});

describe('nudges', () => {
	const { parseNudge, bubbleMarkdown } = require('../src/core/nudge');
	const answers = ['I think it does, but not because the stories are bad. They are good enough, so readers stop asking who wrote them.'];
	test('keeps a recall only when the quote is the writer\'s own words', () => {
		const raw = '```json\n{"bubbles":[{"kind":"recall","text":"That is the turn this paragraph needs.","quote":"readers stop asking  who wrote them"},{"kind":"recall","text":"x","quote":"machines will replace editors"},{"kind":"raise","text":"What does a reader lose?"}]}\n```';
		const b = parseNudge(raw, answers);
		expect(b.map((x: any) => x.kind)).toEqual(['recall', 'raise']);
		expect(bubbleMarkdown(b[0])).toContain('You said: *"readers stop asking  who wrote them"*');
	});
	test('nothing usable gives no bubbles', () => {
		expect(parseNudge('sorry', answers)).toEqual([]);
	});
});
