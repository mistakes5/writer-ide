// The interview workspace: raw-answers.md (append-only answer bank),
// interview-state.md and source-map.md, plus the question sequence and the
// coaxing starters built from the writer's own words. Plain Node fs, no vscode.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Bookmark, Coaxing, QuestionContext, QuestionOption, RawAnswer } from '../shared/protocol';
import { tokenize, type ReadingsIndex } from './readingsIndex';

export const RAW_ANSWERS = 'raw-answers.md';
export const INTERVIEW_STATE = 'interview-state.md';
export const SOURCE_MAP = 'source-map.md';

// One concrete question per turn. Each asks for the writer's own position,
// case or reading; none proposes an answer. The options are forced-choice
// starters for a writer facing an empty box: each names one side of a real
// tension and seeds only an opening clause, which the writer has to finish.
export interface CuratedQuestion {
	question: string;
	options: QuestionOption[];
}

export const CURATED_QUESTIONS: CuratedQuestion[] = [
	// premise
	{
		question: 'In one sentence, what do you think is true here that a reader might push back on?',
		options: [
			{ label: 'It works worse than claimed', seed: 'It works worse than its defenders claim, because ' },
			{ label: 'It works better than feared', seed: 'It works better than its critics fear, because ' },
			{ label: 'The usual explanation misses something', seed: 'The usual explanation misses the real cause, which is ' },
		],
	},
	{
		question: 'Which case, event or example made you think that? Name it and say what happened.',
		options: [
			{ label: 'A case from the readings', seed: 'The case from the readings that convinced me is ' },
			{ label: 'Something I saw myself', seed: 'I saw this happen when ' },
			{ label: 'A recent news event', seed: 'The event that made me think this was ' },
		],
	},
	// mechanism
	{
		question: 'Walk through how it happens: who does what, and what follows from it?',
		options: [
			{ label: 'It starts with a decision', seed: 'It starts when someone decides to ' },
			{ label: 'It starts with a rule', seed: 'It starts with a rule that ' },
			{ label: 'It starts with an incentive', seed: 'It starts because someone gains by ' },
		],
	},
	{
		question: 'Who gains from the outcome you described, and how do they gain?',
		options: [
			{ label: 'Those already in charge', seed: 'The people already in charge gain because ' },
			{ label: 'Those with less power', seed: 'The people with less power gain because ' },
			{ label: 'Nobody gains very much', seed: 'Nobody gains much from this, because ' },
		],
	},
	// strongest objection
	{
		question: 'What is the strongest point someone who disagrees with you would make? Put it in their words.',
		options: [
			{ label: 'They have contrary evidence', seed: 'They would point to evidence that ' },
			{ label: 'They see a hidden cost', seed: 'They would say my view ignores the cost of ' },
			{ label: 'They blame a different cause', seed: 'They would say the real cause is ' },
		],
	},
	{
		question: 'Answer that objection. Which part of it is wrong, and which part do you accept?',
		options: [
			{ label: 'The objection mostly fails', seed: 'The objection fails mainly because ' },
			{ label: 'The objection is partly right', seed: 'The objection is right that ' },
			{ label: 'Right facts, wrong conclusion', seed: 'The facts in the objection hold, yet the conclusion ' },
		],
	},
	// caveat or trade-off
	{
		question: 'Where does your claim stop holding? Name a case it leaves out.',
		options: [
			{ label: 'A different place', seed: 'My claim stops holding in ' },
			{ label: 'A different time period', seed: 'My claim held less well when ' },
			{ label: 'A different group of people', seed: 'My claim leaves out people who ' },
		],
	},
	{
		question: 'What does your position cost the people it affects, and is that cost worth paying?',
		options: [
			{ label: 'The cost is worth paying', seed: 'The cost is worth paying because ' },
			{ label: 'The cost is too high', seed: 'The cost is too high because ' },
			{ label: 'It depends who pays', seed: 'Whether the cost is worth it depends on ' },
		],
	},
	// source tension
	{
		question: 'Which reading pushes back hardest on your view, and on what exact point?',
		options: [
			{ label: 'It disputes my facts', seed: 'The reading that disputes my facts is ' },
			{ label: 'It disputes my reasoning', seed: 'The reading that rejects my reasoning is ' },
			{ label: 'It weighs things differently', seed: 'The reading that weighs things differently is ' },
		],
	},
	{
		question: 'Pick one author you agree with. Which claim of theirs supports you, and where do you go further than they do?',
		options: [
			{ label: 'I extend their claim', seed: 'I take their claim further by arguing that ' },
			{ label: 'I apply it elsewhere', seed: 'I apply their claim to ' },
			{ label: 'I accept only part', seed: 'I accept their point that ' },
		],
	},
];

export const QUESTIONS: string[] = CURATED_QUESTIONS.map(q => q.question);

export function optionsFor(question: string): QuestionOption[] {
	return CURATED_QUESTIONS.find(q => q.question === question)?.options ?? [];
}

const RAW_ANSWERS_HEADER = `# Raw answers

Append-only answer bank. Each entry keeps the question and the answer exactly as written.
Edits and drafts belong in other files.

`;

const INTERVIEW_STATE_TEMPLATE = `# Interview state

## Assignment
- Requirements:
- Length:
- Due:

## Sources
- Assigned readings (path, scope, read in full?):
- Access gaps:

## Working thesis
Open until the answers settle it.

## Outline and word budget

## Coverage
| Section | Point | Support | Your interpretation | Connection | Status |
| --- | --- | --- | --- | --- | --- |

## Current paragraph

## Ideas
- Accepted:
- Revised:
- Rejected:

## Parked tangents

## Draft status

## Remaining gaps

## Next move
`;

export const SOURCE_MAP_TEMPLATE = `# Source map

One row per claim. Page numbers come from the original reading.

| Claim | Your interpretation | Source (Author Year: page) | File and line |
| --- | --- | --- | --- |
`;

const ENTRY = /^<!-- writer-answer id="([^"]+)" ts="([^"]+)" -->\n### [^\n]*\n\nQuestion: ([^\n]*)\n\n/gm;

export function parseRawAnswers(content: string): RawAnswer[] {
	const heads = [...content.matchAll(ENTRY)];
	return heads.map((m, k) => {
		const bodyStart = m.index! + m[0].length;
		const bodyEnd = k + 1 < heads.length ? heads[k + 1].index! : content.length;
		// appendAnswer writes the text followed by exactly two newlines.
		const body = content.slice(bodyStart, bodyEnd);
		return { id: m[1], timestamp: m[2], prompt: m[3], text: body.endsWith('\n\n') ? body.slice(0, -2) : body.replace(/\n$/, '') };
	});
}

export class WorkflowStore {
	constructor(readonly root: string) {}

	file(name: string): string {
		return path.join(this.root, name);
	}

	isReady(): boolean {
		return [RAW_ANSWERS, INTERVIEW_STATE, SOURCE_MAP].every(name => fs.existsSync(this.file(name)));
	}

	// Creates whichever files are missing. Existing files are never rewritten.
	init(): string[] {
		const created: string[] = [];
		const templates: Array<[string, string]> = [
			[RAW_ANSWERS, RAW_ANSWERS_HEADER],
			[INTERVIEW_STATE, INTERVIEW_STATE_TEMPLATE],
			[SOURCE_MAP, SOURCE_MAP_TEMPLATE],
		];
		fs.mkdirSync(this.root, { recursive: true });
		for (const [name, template] of templates) {
			try {
				fs.writeFileSync(this.file(name), template, { flag: 'wx' });
				created.push(name);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw err;
				}
			}
		}
		return created;
	}

	readAnswers(): RawAnswer[] {
		try {
			return parseRawAnswers(fs.readFileSync(this.file(RAW_ANSWERS), 'utf8'));
		} catch {
			return [];
		}
	}

	// Opens the file in append mode only, so earlier entries cannot be touched.
	appendAnswer(prompt: string, text: string, now = new Date()): RawAnswer {
		const answer: RawAnswer = {
			id: crypto.randomBytes(4).toString('hex'),
			timestamp: now.toISOString(),
			prompt: prompt.replace(/\s+/g, ' ').trim(),
			text,
		};
		if (!fs.existsSync(this.file(RAW_ANSWERS))) {
			fs.writeFileSync(this.file(RAW_ANSWERS), RAW_ANSWERS_HEADER, { flag: 'wx' });
		}
		const entry = `<!-- writer-answer id="${answer.id}" ts="${answer.timestamp}" -->\n### ${answer.timestamp}\n\nQuestion: ${answer.prompt}\n\n${text}\n\n`;
		fs.appendFileSync(this.file(RAW_ANSWERS), entry, 'utf8');
		return answer;
	}
}

// From the cursor on, the first question still unanswered; once every
// question has an answer the sequence simply cycles.
export function pickQuestion(answers: RawAnswer[], cursor: number): string {
	const asked = new Set(answers.map(a => a.prompt));
	for (let k = 0; k < QUESTIONS.length; k++) {
		const q = QUESTIONS[(cursor + k) % QUESTIONS.length];
		if (!asked.has(q)) {
			return q;
		}
	}
	return QUESTIONS[cursor % QUESTIONS.length];
}

// ---------------------------------------------------------------------------
// Coaxing: two opening moves built from the writer's exact words.

const PHRASE_WORDS = 14;

function sentences(text: string): string[] {
	return (text.match(/[^.!?\n]+[.!?]*/g) ?? []).map(s => s.trim()).filter(s => s.split(/\s+/).length >= 3);
}

// The writer's words, cut at a word boundary and marked when cut.
function quotePhrase(sentence: string): string {
	const words = sentence.replace(/[.!?]+$/, '').split(/\s+/);
	return words.length > PHRASE_WORDS ? words.slice(0, PHRASE_WORDS).join(' ') + ' ...' : words.join(' ');
}

function overlap(a: string, b: string): number {
	const bs = new Set(tokenize(b).map(t => t.stem));
	return new Set(tokenize(a).map(t => t.stem).filter(s => bs.has(s))).size;
}

function citeLabel(b: Bookmark): string {
	return b.page ? `${b.author} (${b.year}: ${b.page})` : `${b.author} (${b.year})`;
}

export function buildCoaxingStarters(rawAnswers: RawAnswer[], bookmarks: Bookmark[], offset = 0): Coaxing {
	const usable = rawAnswers.filter(a => sentences(a.text).length);
	if (!usable.length) {
		return { heading: 'Answer a question first. Starters are built from your own words.', starters: [], basedOnAnswerId: null };
	}
	const answer = usable[usable.length - 1 - (offset % usable.length)];
	const own = sentences(answer.text);
	const opening = own[0];
	const starters = [`Start from your own line: "${quotePhrase(opening)}". Write the next sentence about the case that made you say it.`];

	const bookmark = bookmarks.find(b => overlap(b.excerpt, answer.text) >= 2) ?? bookmarks[0];
	if (bookmark) {
		const closest = [...own].sort((x, y) => overlap(y, bookmark.excerpt) - overlap(x, bookmark.excerpt))[0];
		starters.push(`Put ${citeLabel(bookmark)} next to "${quotePhrase(closest)}". Say in one sentence whether the passage backs you or cuts against you.`);
	} else if (own.length > 1) {
		starters.push(`You also wrote "${quotePhrase(own[own.length - 1])}". Write the sentence that explains how that happens.`);
	} else {
		starters.push(`Write the sentence that explains how "${quotePhrase(opening)}" happens: who acts, and what follows.`);
	}
	return { heading: `From your answer to "${answer.prompt}"`, starters, basedOnAnswerId: answer.id };
}

// ---------------------------------------------------------------------------
// Question context: the stance options plus at most two passages to read
// before answering, so the writer never has to leave the panel to look.

const FEATURED = 2;
const FEATURE_POOL = 6;

export function buildQuestionContext(question: string, rawAnswers: RawAnswer[], readingsIndex: ReadingsIndex | null): QuestionContext {
	const context: QuestionContext = { question, options: optionsFor(question), featuredBookmarks: [] };
	// Passages are matched to the writer's own answers. The question's wording
	// is generic, so it only breaks ties among those matches.
	if (!readingsIndex || !rawAnswers.length) {
		return context;
	}
	const pool = readingsIndex.matchBookmarks(rawAnswers, FEATURE_POOL);
	const ranked = pool
		.map((b, rank) => ({ b, key: (pool.length - rank) + overlap(question, b.excerpt) * 0.5 }))
		.sort((x, y) => y.key - x.key)
		.map(x => x.b);
	const authors = new Set<string>();
	for (const b of ranked) {
		if (context.featuredBookmarks.length >= FEATURED) {
			break;
		}
		if (!authors.has(b.author + b.year)) {
			authors.add(b.author + b.year);
			context.featuredBookmarks.push(b);
		}
	}
	return context;
}
