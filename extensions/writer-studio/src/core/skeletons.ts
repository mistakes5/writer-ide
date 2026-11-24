// Paragraph skeletons: labelled [Slot: ...] lines the writer replaces with
// their own sentences. They hold structure only, never prose, and are inserted
// only on an explicit command or button press.

import type { SkeletonOption } from '../shared/protocol';

interface Skeleton extends SkeletonOption {
	slots: string[];
}

const SKELETONS: Skeleton[] = [
	{
		id: 'body-triangulate',
		label: 'Body paragraph (3 sources)',
		description: 'Your claim, three quoted sources with a line each, and a bridge.',
		slots: [
			'[Claim: one sentence, in your own words, that this paragraph proves.]',
			'[Source 1: "quote" (Author Year: page). One sentence on what it shows.]',
			'[Source 2: "quote" (Author Year: page). One sentence on what it adds.]',
			'[Source 3: "quote" (Author Year: page). One sentence on where it differs.]',
			'[Bridge: one sentence, in your own words, on what this sets up next.]',
		],
	},
	{
		id: 'caveat-tradeoff',
		label: 'Caveat and trade-off',
		description: 'The tension, the strongest evidence against you, and why your claim still holds.',
		slots: [
			'[Tension: one sentence naming where your claim meets resistance.]',
			'[Counter-evidence: "quote" (Author Year: page). The strongest point against you.]',
			'[Trade-off: one sentence on what your position costs and why it still holds.]',
		],
	},
	{
		id: 'synthesis-bridge',
		label: 'Synthesis and transition',
		description: 'Joins two loose notes into one point and hands it to the next section.',
		slots: [
			'[Note A: the first idea, in a few words.]',
			'[Note B: the second idea, in a few words.]',
			'[Link: one sentence on what A and B show together.]',
			'[Next: one sentence on the question this leaves for the next section.]',
		],
	},
];

export const SKELETON_OPTIONS: SkeletonOption[] = SKELETONS.map(({ id, label, description }) => ({ id, label, description }));

// The slots form one Markdown paragraph: single line breaks, no blank lines.
export function getSkeletonText(id: string): string | null {
	const s = SKELETONS.find(k => k.id === id);
	return s ? s.slots.join('\n') : null;
}

// An unfilled slot, as left by getSkeletonText. Markdown links "[x](y)" never match.
export const SLOT = /\[[A-Z][\w -]{0,30}:[^\]\n]*\](?!\()/g;

export interface SkeletonInsertion {
	line: number; // 0-based insert position
	character: number;
	text: string;
	firstSlotLine: number; // 0-based line of the first slot once inserted
}

// Where a skeleton goes: on a blank cursor line it lands right there,
// otherwise after the paragraph holding the cursor. Either way a blank line
// separates it from the paragraphs around it.
export function planSkeletonInsert(lines: string[], cursorLine: number, skeleton: string): SkeletonInsertion {
	const blank = (i: number) => !lines[i]?.trim();
	let at = Math.min(Math.max(0, cursorLine), Math.max(0, lines.length - 1));
	while (at < lines.length && !blank(at)) {
		at++;
	}
	if (at >= lines.length) {
		// The paragraph runs to the end of the file: append after its last line.
		const last = lines.length - 1;
		return { line: last, character: lines[last].length, text: '\n\n' + skeleton, firstSlotLine: last + 2 };
	}
	// Line `at` is blank and stays below the skeleton as its separator.
	const before = at > 0 && !blank(at - 1) ? '\n' : '';
	return { line: at, character: 0, text: before + skeleton + '\n', firstSlotLine: at + (before ? 1 : 0) };
}
