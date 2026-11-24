// Message contract between src/core/pdfEditor.ts and media/pdf.js.
// Shared with the webview author: change both sides together.
// Page numbers are 1-based PDF page positions, not printed page labels.

export type HighlightColor = 'ochre' | 'sage' | 'brick';

export interface NormalizedRect {
	x: number;
	y: number;
	w: number;
	h: number;
} // 0..1 relative to page box

export interface PdfHighlight {
	id: string;
	page: number; // 1-based PDF page
	text: string; // selected verbatim text
	note: string; // optional writer note
	color: HighlightColor;
	rects: NormalizedRect[];
	createdAt: string; // ISO 8601
}

export interface PdfBookmark {
	id: string;
	page: number; // 1-based PDF page
	label: string;
	createdAt: string; // ISO 8601
}

export type PdfHostToWebview =
	| { type: 'pdfInit'; fileName: string; pdfUri: string; highlights: PdfHighlight[]; bookmarks: PdfBookmark[]; initialPage?: number }
	| { type: 'pdfData'; highlights: PdfHighlight[]; bookmarks: PdfBookmark[] }
	| { type: 'pdfGoToPage'; page: number }
	| { type: 'pdfExtractText'; reqId: number }
	| { type: 'pdfSuggest'; items: PdfSuggestion[] };

// A passage the companion found for the paragraph being written. The quote is
// checked verbatim against the page text before it is sent.
export interface PdfSuggestion {
	page: number; // 1-based PDF page
	quote: string;
	stance: 'supports' | 'complicates';
	why: string;
}

export type PdfWebviewToHost =
	| { type: 'pdfReady' }
	| { type: 'pdfText'; reqId: number; pages: string[] }
	| { type: 'addHighlight'; highlight: Omit<PdfHighlight, 'id' | 'createdAt'> }
	| { type: 'deleteHighlight'; id: string }
	| { type: 'updateHighlightNote'; id: string; note: string }
	| { type: 'toggleBookmark'; page: number; label: string }
	| { type: 'deleteBookmark'; id: string }
	| { type: 'sendToDraft'; text: string; page: number; fileName: string }
	| { type: 'appendToSourceMap'; text: string; page: number; fileName: string };
