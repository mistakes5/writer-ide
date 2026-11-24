import { describe, expect, test } from 'bun:test';
import { buildPrompt, paragraphAt, parseSuggestions, verify } from '../src/core/companion';

const pages = [
	'Cover page and journal details.',
	'The relationship here is telling: the more the non‑human origin of its stories is undetectable, the more it promises to disrupt news production.',
];

describe('companion', () => {
	test('paragraphAt returns the blank-line block around the cursor', () => {
		const text = 'Title\n\nFirst line of para\nsecond line\n\nNext para';
		expect(paragraphAt(text, 3)).toBe('First line of para second line');
		expect(paragraphAt(text, 5)).toBe('Next para');
	});

	test('verify keeps verbatim quotes, fixes the page, drops paraphrase', () => {
		const out = verify(
			[
				{ page: 1, quote: '“the more the non-human origin of its stories is undetectable”', stance: 'supports', why: '' },
				{ page: 2, quote: 'automation always disrupts newsrooms everywhere', stance: 'complicates', why: '' },
				{ page: 2, quote: 'is telling', stance: 'supports', why: '' },
			],
			pages,
		);
		expect(out).toHaveLength(1);
		expect(out[0].page).toBe(2);
	});

	test('parseSuggestions reads a fenced JSON array and normalises stance', () => {
		const raw = 'Here you go:\n```json\n[{"page": 2, "quote": " a quote ", "stance": "challenges", "why": "x"}, {"quote": 5}]\n```';
		expect(parseSuggestions(raw)).toEqual([{ page: 2, quote: 'a quote', stance: 'supports', why: 'x' }]);
		expect(parseSuggestions('no json')).toEqual([]);
	});

	test('buildPrompt numbers pages for the model', () => {
		const p = buildPrompt('My paragraph.', 'Carlson.pdf', pages);
		expect(p).toContain('[[PDF PAGE 2]]');
		expect(p).toContain('My paragraph.');
	});
});
