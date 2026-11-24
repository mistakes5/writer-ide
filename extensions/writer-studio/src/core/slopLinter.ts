// Prose linter for the writer's drafts. analyzeDocument() is pure; the
// vscode wiring at the bottom feeds it open Markdown files and publishes the
// results to the 'writer-lint' DiagnosticCollection.

import type * as vscodeTypes from 'vscode';
import type { LintDiagnostic, Severity } from '../shared/protocol';
import { parseCitations } from './citationNav';

export interface QuoteSource {
	readonly size: number;
	containsQuote(quote: string): boolean;
}

export interface Finding extends LintDiagnostic {
	length: number; // characters covered, for the editor squiggle
}

interface PatternRule {
	code: string;
	severity: Severity;
	pattern: RegExp;
	message: (match: string) => string;
}

const BANNED_WORDS: Record<string, string> = {
	delve: 'Say what you look at: "examine", "read", "go through".',
	tapestry: 'Name the actual parts and how they connect.',
	multifaceted: 'Name the facets you mean.',
	nuance: 'State the qualification itself.',
	foster: 'Say who does what: "encourage", "build", "pay for".',
	leverage: '"use" says the same thing.',
	underscore: 'Say what the evidence shows.',
	navigate: 'Name what the person actually does.',
	landscape: 'Name the field, market or group you mean.',
	pivotal: 'Show why it decided the outcome.',
	intricate: 'Name the parts that make it complicated.',
	testament: 'Say what it proves and how.',
	realm: 'Name the field.',
	paradigm: 'Name the model or assumption.',
	robust: 'Say what it withstands.',
	streamline: 'Say what got shorter or cheaper.',
	holistic: 'Name what is being taken into account.',
};

const BANNED_FORMS =
	'delv(?:e|es|ed|ing)|tapestr(?:y|ies)|multifaceted|nuanc(?:e|es|ed)|foster(?:s|ed|ing)?|' +
	'leverag(?:e|es|ed|ing)|underscor(?:e|es|ed|ing)|navigat(?:e|es|ed|ing)|landscapes?|pivotal|' +
	'intricate(?:ly)?|testaments?|realms?|paradigms?|robust(?:ly|ness)?|streamlin(?:e|es|ed|ing)|holistic(?:ally)?';

function bannedBase(word: string): string {
	const w = word.toLowerCase();
	return Object.keys(BANNED_WORDS).find(base => w.startsWith(base.slice(0, Math.max(4, base.length - 2)))) ?? w;
}

const NEGATIVE_PARALLELISM = 'Names a position to reject before the one you hold. Lead with the claim you hold.';

const RULES: PatternRule[] = [
	{ code: 'negative-parallelism', severity: 'warning', pattern: /\bnot\s+(?:just|only|merely|simply)\b/gi, message: () => NEGATIVE_PARALLELISM },
	{ code: 'negative-parallelism', severity: 'warning', pattern: /\bnot\s+(?!just\b|only\b|merely\b|simply\b)[^.!?;:\n]{1,60}?,\s*but\b/gi, message: () => NEGATIVE_PARALLELISM },
	{ code: 'negative-parallelism', severity: 'warning', pattern: /\brather than\b[^.!?\n]{1,80}?,/gi, message: () => '"Rather than X, Y" defines the point by what it replaces. State Y directly.' },
	{ code: 'negative-parallelism', severity: 'warning', pattern: /\b(?:it|this|that)(?:'s|’s| is) not\b[^.!?\n]{1,60}?[,;]\s*(?:it|this|that)(?:'s|’s| is)\b/gi, message: () => NEGATIVE_PARALLELISM },
	{ code: 'negative-parallelism', severity: 'warning', pattern: /\bis not the (\w+)\.\s+[^.!?\n]{1,80}?\bis the \1\b/gi, message: () => 'The same "not X. Y is" contrast runs across two sentences. Keep the second claim.' },
	{ code: 'hedge-verb', severity: 'warning', pattern: /\bsuggest(?:s|ing)\b/gi, message: () => 'Say what the author claims or what the evidence shows.' },
	{ code: 'hedge-verb', severity: 'warning', pattern: /\balign(?:s|ed|ing)? with\b/gi, message: () => 'Say how the two agree: same claim, same cause or same result.' },
	{ code: 'em-dash', severity: 'error', pattern: /—|(?<=\s)–(?=\s)|(?<![-\w])--(?![-\w])|(?<=\w)--(?=\w)/g, message: () => 'Dash. Use a comma, a period or parentheses.' },
	{ code: 'ai-vocabulary', severity: 'warning', pattern: new RegExp(`\\b(?:${BANNED_FORMS})\\b`, 'gi'), message: m => `"${m}" is on the banned list. ${BANNED_WORDS[bannedBase(m)] ?? ''}`.trim() },
	{ code: 'self-commentary', severity: 'info', pattern: /,\s*and (?:that|this)(?:'s|’s| is) (?:exactly |precisely )?(?:what|why)\b[^.!?\n]*/gi, message: () => 'The tail comments on the claim. Cut it, or state the actual reason or consequence.' },
	{ code: 'self-commentary', severity: 'info', pattern: /,\s*which is (?:why|what) (?:it|this|that) (?:matters|counts)\b/gi, message: () => 'The tail comments on the claim. Cut it, or state the actual reason or consequence.' },
	{ code: 'abstract-recasting', severity: 'info', pattern: /\b(?:becomes|became|turns into|turned into|is transformed into|serves as|functions as)\s+(?:the|a|an)\s+[\p{L}-]+/giu, message: () => 'Possible "X becomes Y" recasting. If it renames a concept, name the person, the action and the judgment instead.' },
];

const MAX_CITED_PAGES = 3;
const MIN_CHECKED_QUOTE = 25;
const EXCERPT_CHARS = 80;
const QUOTE = /“([^”\n]+)”|"([^"\n]+)"/g;

const blank = (s: string) => ' '.repeat(s.length);

// Code, links, URLs and HTML comments are blanked so they never trigger
// prose rules. Columns stay aligned with the original text.
function maskLine(line: string): string {
	return line
		.replace(/`[^`]*`/g, blank)
		.replace(/<!--.*?-->/g, blank)
		.replace(/\]\([^)]*\)/g, blank)
		.replace(/<https?:[^>]*>/g, blank)
		.replace(/https?:\/\/\S+/g, blank);
}

function maskQuotes(line: string): string {
	return line.replace(QUOTE, blank);
}

function semicolonColumns(line: string): number[] {
	const cols: number[] = [];
	let depth = 0;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '(' || ch === '[') {
			depth++;
		} else if ((ch === ')' || ch === ']') && depth > 0) {
			depth--;
		} else if (ch === ';' && depth === 0 && !/&#?\w+$/.test(line.slice(0, i))) {
			cols.push(i);
		}
	}
	return cols;
}

const DASH_CONTEXT = 25;

// A dash alone says nothing in a list of findings: show the words around it,
// cut at word boundaries and marked with "..." where the line continues.
export function dashContext(line: string, col: number, length: number): string {
	let start = Math.max(0, col - DASH_CONTEXT);
	let end = Math.min(line.length, col + length + DASH_CONTEXT);
	if (start > 0) {
		const space = line.indexOf(' ', start);
		start = space >= 0 && space < col ? space + 1 : start;
	}
	if (end < line.length) {
		const space = line.lastIndexOf(' ', end);
		end = space > col + length ? space : end;
	}
	const body = line.slice(start, end).trim();
	return (start > 0 ? '...' : '') + body + (end < line.length ? '...' : '');
}

function excerpt(s: string): string {
	const t = s.trim();
	return t.length > EXCERPT_CHARS ? t.slice(0, EXCERPT_CHARS - 3) + '...' : t;
}

export function analyzeDocument(text: string, readings?: QuoteSource | null): Finding[] {
	const findings: Finding[] = [];
	const lines = text.split(/\r?\n/);
	const add = (line: number, col: number, length: number, severity: Severity, code: string, message: string, raw: string) => {
		findings.push({ line: line + 1, col: col + 1, length, severity, code, message, excerpt: excerpt(raw) });
	};

	let inFence = false;
	let inFrontMatter = lines[0]?.trim() === '---';
	for (let i = 0; i < lines.length; i++) {
		const original = lines[i];
		if (inFrontMatter) {
			if (i > 0 && original.trim() === '---') {
				inFrontMatter = false;
			}
			continue;
		}
		if (/^\s*(```|~~~)/.test(original)) {
			inFence = !inFence;
			continue;
		}
		if (inFence || /^\s*([-*_])(\s*\1){2,}\s*$/.test(original) || /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(original)) {
			continue;
		}
		const masked = maskLine(original);
		// Block quotes and quotation marks hold source wording: style rules skip them.
		const prose = /^\s*>/.test(masked) ? '' : maskQuotes(masked);

		const seen = new Set<string>();
		for (const rule of RULES) {
			for (const m of prose.matchAll(rule.pattern)) {
				const key = `${rule.code}:${m.index}`;
				if (seen.has(key)) {
					continue;
				}
				seen.add(key);
				const raw = rule.code === 'em-dash' ? dashContext(original, m.index!, m[0].length) : m[0];
				add(i, m.index!, m[0].length, rule.severity, rule.code, rule.message(m[0]), raw);
			}
		}

		for (const col of semicolonColumns(prose)) {
			const sentenceStart = Math.max(original.lastIndexOf('.', col) + 1, 0);
			add(i, col, 1, 'warning', 'semicolon', 'Semicolon in prose. Split the sentence or join with a comma and "and".', original.slice(sentenceStart, col + 30));
		}

		for (const c of parseCitations(masked)) {
			if (c.pageStart !== null && c.pageEnd !== null && c.pageEnd - c.pageStart + 1 > MAX_CITED_PAGES) {
				const pages = c.pageEnd - c.pageStart + 1;
				add(i, c.start, c.end - c.start, 'warning', 'wide-page-range', `This citation spans ${pages} pages. Cite the page that holds the point.`, c.text);
			}
		}

		if (readings && readings.size > 0) {
			for (const m of masked.matchAll(QUOTE)) {
				const inner = m[1] ?? m[2];
				if (inner.trim().length > MIN_CHECKED_QUOTE && !readings.containsQuote(inner)) {
					add(i, m.index!, m[0].length, 'warning', 'unverified-quote', 'No indexed reading contains this wording. Check it against the source before keeping the quotation marks.', m[0]);
				}
			}
		}
	}
	return findings.sort((a, b) => a.line - b.line || a.col - b.col);
}

// ---------------------------------------------------------------------------
// VS Code wiring

const WORKFLOW_FILES = /(?:^|[\\/])(?:raw-answers|interview-state|source-map)\.md$/i;
const DEBOUNCE_MS = 350;

export interface SlopLinter extends vscodeTypes.Disposable {
	lint(doc: vscodeTypes.TextDocument): Finding[];
	lintOpenDocuments(): void;
}

// Files directly inside a sources/ or readings/ folder hold source wording
// (captured web pages among them). They are read, not drafted.
const SOURCE_FILE = /(?:^|[\\/])(?:sources?|readings?)[\\/][^\\/]+$/i;

export function shouldLint(doc: vscodeTypes.TextDocument): boolean {
	return doc.languageId === 'markdown' && !WORKFLOW_FILES.test(doc.fileName) && !SOURCE_FILE.test(doc.fileName);
}

export function createSlopLinter(
	vscode: typeof vscodeTypes,
	getReadings: () => QuoteSource | null,
	isLive: () => boolean,
	onLinted: (doc: vscodeTypes.TextDocument, findings: Finding[]) => void,
): SlopLinter {
	const collection = vscode.languages.createDiagnosticCollection('writer-lint');
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const severities: Record<Severity, vscodeTypes.DiagnosticSeverity> = {
		error: vscode.DiagnosticSeverity.Error,
		warning: vscode.DiagnosticSeverity.Warning,
		info: vscode.DiagnosticSeverity.Information,
	};

	const lint = (doc: vscodeTypes.TextDocument): Finding[] => {
		if (!shouldLint(doc)) {
			return [];
		}
		const findings = analyzeDocument(doc.getText(), getReadings());
		collection.set(doc.uri, findings.map(f => {
			const range = new vscode.Range(f.line - 1, f.col - 1, f.line - 1, f.col - 1 + f.length);
			const d = new vscode.Diagnostic(range, f.message, severities[f.severity]);
			d.source = 'Writer';
			d.code = f.code;
			return d;
		}));
		onLinted(doc, findings);
		return findings;
	};

	const schedule = (doc: vscodeTypes.TextDocument) => {
		if (!isLive() || !shouldLint(doc)) {
			return;
		}
		const key = doc.uri.toString();
		clearTimeout(timers.get(key));
		timers.set(key, setTimeout(() => {
			timers.delete(key);
			lint(doc);
		}, DEBOUNCE_MS));
	};

	const lintOpenDocuments = () => {
		if (!isLive()) {
			collection.clear();
			return;
		}
		vscode.workspace.textDocuments.forEach(doc => shouldLint(doc) && lint(doc));
	};

	const subscriptions = [
		collection,
		vscode.workspace.onDidOpenTextDocument(schedule),
		vscode.workspace.onDidChangeTextDocument(e => schedule(e.document)),
		vscode.workspace.onDidCloseTextDocument(doc => collection.delete(doc.uri)),
	];

	return {
		lint,
		lintOpenDocuments,
		dispose() {
			timers.forEach(clearTimeout);
			timers.clear();
			subscriptions.forEach(s => s.dispose());
		},
	};
}
