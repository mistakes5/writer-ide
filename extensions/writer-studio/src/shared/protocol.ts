// Message contract between the extension host and media/panel.js.
// Shared with the webview author: change both sides together.
// Line and column numbers are 1-based everywhere in this file.

export interface RawAnswer {
	id: string;
	timestamp: string; // ISO 8601
	prompt: string;
	text: string; // verbatim, exactly as saved in raw-answers.md
}

export interface Bookmark {
	id: string;
	author: string;
	year: string;
	// Printed page when the reading marks one ("17"), PDF position otherwise ("PDF 9").
	page: string;
	filePath: string;
	line: number;
	excerpt: string; // verbatim text from filePath at line
	reason: string;
	score: number;
}

export interface Coaxing {
	heading: string;
	starters: string[];
	basedOnAnswerId: string | null;
}

export type Severity = 'error' | 'warning' | 'info';

export interface LintDiagnostic {
	line: number;
	col: number;
	severity: Severity;
	code: string;
	message: string;
	excerpt: string;
}

// ---- v0.2 ------------------------------------------------------------

// One prose paragraph of the active draft, as the outline and lenses see it.
export interface ParagraphOutlineNode {
	index: number; // 1-based paragraph number
	line: number; // 1-based starting line in activeFile
	heading: string; // nearest preceding Markdown heading or "(Opening)"
	preview: string; // first ~75 chars of the paragraph
	words: number;
	distinctSources: number;
	quoteCount: number;
	hasCounterMove: boolean;
	gaps: string[]; // plain-language gaps, e.g. ["0/3 sources", "no direct quote"]
	matchedAnswerIds: string[]; // RawAnswer ids sharing keywords with this paragraph
}

export interface QuestionOption {
	label: string; // 3-6 word stance, never an answer
	seed: string; // opening clause placed in the answer box; the writer finishes it
}

export interface QuestionContext {
	question: string;
	options: QuestionOption[]; // 2-3 forced-choice starters
	featuredBookmarks: Bookmark[]; // up to 2 reading excerpts for this question
}

export interface SkeletonOption {
	id: string;
	label: string;
	description: string;
}

export interface StateMessage {
	type: 'state';
	workspaceReady: boolean;
	activeFile: string | null;
	rawAnswers: RawAnswer[];
	currentQuestion: string;
	bookmarks: Bookmark[];
	coaxing: Coaxing;
	diagnostics: LintDiagnostic[];
	// v0.2
	questionContext: QuestionContext;
	outline: ParagraphOutlineNode[];
	skeletons: SkeletonOption[];
}

export type ExtensionToWebview = StateMessage;

export type WebviewToExtension =
	| { type: 'ready' }
	| { type: 'initWorkspace' }
	| { type: 'submitAnswer'; prompt: string; text: string }
	| { type: 'nextQuestion' }
	| { type: 'refreshBookmarks' }
	| { type: 'openReading'; filePath: string; line: number }
	| { type: 'generateCoax' }
	| { type: 'jumpDiagnostic'; line: number }
	// v0.2
	| { type: 'jumpLine'; line: number }
	| { type: 'insertSkeleton'; skeletonId: string }
	// v0.4: the assistant chat and the launcher
	| { type: 'chatSend'; text: string }
	| { type: 'mindMap' }
	| { type: 'launch'; what: LaunchTarget };

export type LaunchTarget = 'pdf' | 'browser' | 'terminal' | 'claude' | 'capture' | 'lint';

export interface ChatMessage {
	type: 'chat';
	turns: Array<{ role: 'assistant' | 'writer'; text: string }>;
	busy: boolean;
	phase: 'define' | 'interview';
	brief: string;
	error: string;
}
