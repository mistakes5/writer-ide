/*
 * VSwriter PDF reader, webview side.
 *
 * Shows one PDF beside the draft: pages painted by the vendored PDF.js, text
 * the writer can select, saved highlights and bookmarks, and find. The
 * extension host owns the data; this file posts what the writer did and draws
 * whatever comes back. The message shapes are in src/shared/pdfProtocol.ts.
 *
 * Text from the PDF, notes, labels and file names reach the page through
 * textContent only.
 */

const vscode = acquireVsCodeApi();

const byId = (id) => document.getElementById(id);
const ui = {
	viewer: byId('viewer'),
	pages: byId('pages'),
	notice: byId('notice'),
	pagePrev: byId('page-prev'),
	pageNext: byId('page-next'),
	pageNumber: byId('page-number'),
	pageCount: byId('page-count'),
	zoomOut: byId('zoom-out'),
	zoomIn: byId('zoom-in'),
	zoomLevel: byId('zoom-level'),
	zoomFit: byId('zoom-fit'),
	findInput: byId('find-input'),
	findTally: byId('find-tally'),
	findPrev: byId('find-prev'),
	findNext: byId('find-next'),
	bookmarkToggle: byId('bookmark-toggle'),
	bookmarkWord: byId('bookmark-word'),
	bookmarkRest: byId('bookmark-rest'),
	drawerToggle: byId('drawer-toggle'),
	drawer: byId('drawer'),
	suggest: byId('suggest'),
	suggestions: byId('suggestions'),
	suggestTally: byId('suggest-tally'),
	selbar: byId('selbar'),
	selPage: byId('sel-page'),
	selQuote: byId('sel-quote'),
	selStatus: byId('sel-status'),
	selQuoteDraft: byId('sel-quote-draft'),
	selSourceMap: byId('sel-source-map'),
	bookmarks: byId('bookmarks'),
	bookmarksTally: byId('bookmarks-tally'),
	bookmarksEmpty: byId('bookmarks-empty'),
	highlights: byId('highlights'),
	highlightsTally: byId('highlights-tally'),
	highlightsEmpty: byId('highlights-empty'),
};

const INKS = ['ochre', 'sage', 'brick'];
const CSS_PER_POINT = 96 / 72; // a PDF point at 100%
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const MAX_CANVAS_PIXELS = 16_000_000; // about 64 MB a sheet; past this the sheet is painted coarser
const KEEP_CANVASES = 5; // sheets kept painted either side of the one being read
const KEEP_TEXT = 24;
const MAX_MATCHES = 2000;
const PREVIEW_CHARS = 140;
const EXCERPT_CHARS = 320;
const LABEL_CHARS = 80;
const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl';

const state = {
	lib: null,
	doc: null,
	docSeq: 0, // bumped on every open, so work for an older document can tell it is stale
	uri: '',
	opening: '', // the URI being loaded, so a repeated pdfInit does not start it twice
	fileName: '',
	pages: [], // one record per sheet, see makePage
	page: 1,
	pinnedTop: -1, // scrollTop after a jump; the page stays as asked until the writer scrolls
	zoom: 1,
	fit: true,
	scale: CSS_PER_POINT, // CSS pixels per PDF point
	highlights: [],
	bookmarks: [],
	currentHighlight: '',
	selection: null, // { text, page, lastPage, pieces: [{ page, text, rects }] }
	find: { query: '', matches: [], index: -1, seq: 0, capped: false },
	suggest: { items: [], matches: [], current: -1, seq: 0, touched: 0, revealAt: 0 },
	wanted: null, // { page, zoom, fit } restored from the last session, applied once the document is open
};


/* Small helpers ------------------------------------------------------- */

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const dpr = () => window.devicePixelRatio || 1;
const post = (message) => vscode.postMessage(message);
const pageAt = (n) => state.pages[n - 1];

// The same joins the host makes before it puts a quote in the draft
// (cleanSelection in src/core/pdfStore.ts): a word broken over a line is
// rejoined, layout newlines become spaces. Used for what is shown here; the
// text that is posted keeps its line breaks so the host can do this itself.
function flowText(text) {
	return String(text)
		.replace(/­/g, '')
		.replace(/(\p{Ll})-[ \t]*\r?\n\s*(\p{Ll})/gu, '$1$2')
		.replace(/\s+/g, ' ')
		.trim();
}

// Cuts at a word boundary and marks the cut.
function cut(text, max) {
	if (text.length <= max) {
		return text;
	}
	const head = text.slice(0, max);
	const space = head.lastIndexOf(' ');
	return (space > max * 0.6 ? head.slice(0, space) : head).replace(/[\s,;:]+$/, '') + '…';
}

function plural(n, one, many) {
	return n + ' ' + (n === 1 ? one : many);
}

function saveState() {
	vscode.setState({
		uri: state.uri,
		page: state.page,
		zoom: state.zoom,
		fit: state.fit,
		drawer: !ui.drawer.hidden,
	});
}

function setNotice(text, isError) {
	ui.notice.textContent = text;
	ui.notice.hidden = !text;
	ui.notice.classList.toggle('is-error', Boolean(isError));
}

// Runs a change that may move or resize the sheets and keeps the line the
// writer was reading where it was on screen.
function keepPlace(change) {
	const viewer = ui.viewer;
	const top = viewer.scrollTop;
	let anchor = null;
	for (const p of state.pages) {
		if (p.el.offsetTop + p.el.offsetHeight > top) {
			anchor = p;
			break;
		}
	}
	const within = anchor ? (top - anchor.el.offsetTop) / Math.max(1, anchor.el.offsetHeight) : 0;
	const across = viewer.scrollWidth > viewer.clientWidth
		? (viewer.scrollLeft + viewer.clientWidth / 2) / viewer.scrollWidth
		: 0.5;
	change();
	if (anchor) {
		viewer.scrollTop = anchor.el.offsetTop + within * anchor.el.offsetHeight;
	}
	if (viewer.scrollWidth > viewer.clientWidth) {
		viewer.scrollLeft = across * viewer.scrollWidth - viewer.clientWidth / 2;
	}
}

// Showing or hiding a strip above the viewer would slide the sheet under the
// pointer. The scroll position takes up the difference.
function keepSheetStill(change) {
	const before = ui.viewer.getBoundingClientRect().top;
	change();
	const moved = ui.viewer.getBoundingClientRect().top - before;
	if (moved) {
		ui.viewer.scrollTop += moved;
	}
}


/* Incoming data ------------------------------------------------------- */

const unit = (n) => (Number.isFinite(n) ? clamp(n, 0, 1) : 0);

// The notes file is plain JSON the writer may have edited by hand, so every
// field is checked before it is drawn.
function cleanHighlights(list) {
	const out = [];
	for (const raw of Array.isArray(list) ? list : []) {
		if (!raw || typeof raw.id !== 'string' || !Number.isInteger(raw.page) || raw.page < 1) {
			continue;
		}
		const rects = [];
		for (const r of Array.isArray(raw.rects) ? raw.rects : []) {
			if (r && Number.isFinite(r.x) && Number.isFinite(r.y) && r.w > 0 && r.h > 0) {
				rects.push({ x: unit(r.x), y: unit(r.y), w: unit(r.w), h: unit(r.h) });
			}
		}
		out.push({
			id: raw.id,
			page: raw.page,
			text: typeof raw.text === 'string' ? raw.text : '',
			note: typeof raw.note === 'string' ? raw.note : '',
			color: INKS.includes(raw.color) ? raw.color : 'ochre',
			rects,
		});
	}
	const top = (h) => (h.rects.length ? h.rects[0].y : 0);
	return out.sort((a, b) => a.page - b.page || top(a) - top(b));
}

function cleanBookmarks(list) {
	const out = [];
	for (const raw of Array.isArray(list) ? list : []) {
		if (raw && typeof raw.id === 'string' && Number.isInteger(raw.page) && raw.page >= 1) {
			out.push({ id: raw.id, page: raw.page, label: typeof raw.label === 'string' ? raw.label : '' });
		}
	}
	return out.sort((a, b) => a.page - b.page);
}

function setData(highlights, bookmarks) {
	state.highlights = cleanHighlights(highlights);
	state.bookmarks = cleanBookmarks(bookmarks);
	if (!state.highlights.some((h) => h.id === state.currentHighlight)) {
		state.currentHighlight = '';
	}
	drawAllMarks();
	renderBookmarks();
	renderHighlights();
	updateKeepButtons();
}


/* Opening a document -------------------------------------------------- */

const metaContent = (name) => document.querySelector('meta[name="' + name + '"]')?.content || '';

async function loadLibrary() {
	if (!state.lib) {
		const lib = await import(metaContent('vswriter-pdf-js'));
		// Inside a VS Code webview the worker lives on another origin. PDF.js's own
		// fallback (a blob that imports it) fails silently there and getDocument
		// never settles, so fetch the worker source and start it from a
		// same-origin blob. connect-src and worker-src blob: allow both steps.
		const src = await (await fetch(metaContent('vswriter-pdf-worker'))).text();
		const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
		lib.GlobalWorkerOptions.workerPort = new Worker(url, { type: 'module' });
		state.lib = lib;
	}
	return state.lib;
}

// Image decoders and the standard 14 fonts sit beside the library when they
// have been vendored. PDF.js asks for them only for PDFs that need them.
function assetOptions() {
	let base;
	try {
		base = new URL('./', new URL(metaContent('vswriter-pdf-js'), document.baseURI)).href;
	} catch {
		return {};
	}
	return { wasmUrl: base + 'wasm/', standardFontDataUrl: base + 'standard_fonts/', iccUrl: base + 'iccs/' };
}

function makePage(n, w, h) {
	const page = el('div', 'page');
	page.dataset.page = String(n);
	page.setAttribute('aria-label', 'Page ' + n);
	const sheet = el('div', 'sheet');
	const marks = el('div', 'marks');
	const text = el('div', 'textLayer');
	page.append(sheet, marks, text);
	return {
		n,
		el: page,
		sheet,
		marks,
		textEl: text,
		w, // size in PDF points, rotation applied
		h,
		sized: false, // true once w and h come from this page and not from page 1
		proxy: null,
		near: false, // within a screen of the viewport
		paintedScale: 0,
		paintedDpr: 0,
		text: 'none', // 'none' | 'loading' | 'done' | 'failed'
		textLayer: null,
		textReady: null,
		content: null, // what PDF.js read from the page: text items and their fonts
		items: null, // the items that hold text, in the order of the text layer's runs
		itemsReady: null,
		search: null, // { folded, item, offset } built from items on first find
		ink: null, // { x0, y0, x1, y1 } in points: where the printed ink sits, once measured
	};
}

// Fit shows each sheet trimmed to its ink: the box holding every printed
// pixel, text, figures and rules alike, plus a margin. The sheet itself is
// painted whole and slid inside the trimmed frame, so nothing printed is lost.
function sizePage(p) {
	const s = state.scale;
	const box = state.fit && p.ink;
	const style = p.el.style;
	style.setProperty('--total-scale-factor', String(s));
	style.setProperty('--full-w', Math.floor(p.w * s) + 'px');
	style.setProperty('--full-h', Math.floor(p.h * s) + 'px');
	style.setProperty('--crop-x', (box ? box.x0 * s : 0) + 'px');
	style.setProperty('--crop-y', (box ? box.y0 * s : 0) + 'px');
	p.el.classList.toggle('cropped', Boolean(box));
	const w = box ? box.x1 - box.x0 : p.w;
	style.width = Math.floor(w * s) + 'px';
	style.height = Math.floor((box ? box.y1 - box.y0 : p.h) * s) + 'px';
	// A sheet wider than the body pages (a cover sheet, a wide table) is
	// shown smaller rather than pushed off the side.
	const room = fitRoom();
	style.zoom = state.fit && room > 0 && w * s > room ? String(room / (w * s)) : '';
}

// Where a point a fraction y down the whole sheet sits in the viewer.
function pageY(p, y) {
	const crop = state.fit && p.ink ? p.ink.y0 : 0;
	const z = parseFloat(p.el.style.zoom) || 1;
	return p.el.offsetTop + (y * p.h - crop) * state.scale * z;
}

const INK_SCALE = 0.5; // a quarter of the pixels of a 72 dpi render: enough to find the margins
const INK_PAD = 14; // points of margin kept around the ink

// The box of printed ink on a sheet, in PDF points, read from a small
// offscreen render. Null when the sheet is blank.
async function inkBox(p) {
	const proxy = await proxyFor(p);
	const viewport = proxy.getViewport({ scale: INK_SCALE });
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.ceil(viewport.width));
	canvas.height = Math.max(1, Math.ceil(viewport.height));
	await proxy.render({ canvas, viewport, background: 'rgb(255,255,255)' }).promise;
	const { data, width, height } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
	let x0 = width, y0 = height, x1 = -1, y1 = -1;
	for (let y = 0; y < height; y++) {
		const row = y * width * 4;
		for (let x = 0; x < width; x++) {
			const i = row + x * 4;
			if (data[i] + data[i + 1] + data[i + 2] < 3 * 236) {
				if (x < x0) x0 = x;
				if (x > x1) x1 = x;
				if (y < y0) y0 = y;
				if (y > y1) y1 = y;
			}
		}
	}
	canvas.width = canvas.height = 0;
	if (x1 < 0) {
		return null;
	}
	const k = 1 / INK_SCALE;
	return {
		x0: Math.max(0, x0 * k - INK_PAD),
		y0: Math.max(0, y0 * k - INK_PAD),
		x1: Math.min(p.w, (x1 + 1) * k + INK_PAD),
		y1: Math.min(p.h, (y1 + 1) * k + INK_PAD),
	};
}

async function proxyFor(p) {
	if (!p.proxy) {
		p.proxy = await state.doc.getPage(p.n);
	}
	if (!p.sized) {
		p.sized = true;
		const v = p.proxy.getViewport({ scale: 1 });
		if (Math.abs(v.width - p.w) > 0.5 || Math.abs(v.height - p.h) > 0.5) {
			keepPlace(() => {
				p.w = v.width;
				p.h = v.height;
				sizePage(p);
			});
		}
	}
	return p.proxy;
}

async function closeDocument() {
	if (active && active.task) {
		active.task.cancel();
	}
	pageWatch.disconnect();
	CSS.highlights?.delete('vsw-find');
	CSS.highlights?.delete('vsw-find-current');
	textEnds.clear();
	ui.pages.replaceChildren();
	state.pages = [];
	state.find = { query: state.find.query, matches: [], index: -1, seq: state.find.seq + 1, capped: false };
	setSelection(null);
	const doc = state.doc;
	state.doc = null;
	if (doc) {
		await doc.loadingTask.destroy().catch(() => {});
	}
}

async function openDocument(init) {
	const seq = ++state.docSeq;
	state.opening = init.pdfUri;
	await closeDocument();
	if (seq !== state.docSeq) {
		return;
	}
	state.uri = init.pdfUri;
	state.fileName = init.fileName;
	document.title = init.fileName;
	setControls(false);
	setNotice('Opening ' + init.fileName);

	let doc;
	try {
		const lib = await loadLibrary();
		doc = await lib.getDocument({ url: init.pdfUri, ...assetOptions() }).promise;
	} catch (error) {
		if (seq === state.docSeq) {
			state.opening = '';
			setNotice(openFailure(error), true);
		}
		return;
	}
	if (seq !== state.docSeq) {
		doc.loadingTask.destroy().catch(() => {});
		return;
	}
	state.doc = doc;
	state.opening = '';

	const first = await doc.getPage(1);
	const size = first.getViewport({ scale: 1 });
	const shells = [];
	for (let n = 1; n <= doc.numPages; n++) {
		const p = makePage(n, size.width, size.height);
		state.pages.push(p);
		shells.push(p.el);
	}
	state.pages[0].proxy = first;
	state.pages[0].sized = true;

	const wanted = state.wanted && state.wanted.uri === init.pdfUri ? state.wanted : null;
	state.wanted = null;
	state.fit = wanted ? wanted.fit !== false : true;
	state.zoom = wanted && Number.isFinite(wanted.zoom) ? clamp(wanted.zoom, 0.25, 4) : 1;
	state.scale = state.fit ? fitScale() : state.zoom * CSS_PER_POINT;
	state.zoom = state.scale / CSS_PER_POINT;
	for (const p of state.pages) {
		sizePage(p);
	}
	ui.pages.append(...shells);
	for (const p of state.pages) {
		pageWatch.observe(p.el);
	}

	setNotice('');
	setControls(true);
	ui.pageCount.textContent = 'of ' + doc.numPages;
	ui.pageNumber.setAttribute('aria-label', 'Page, of ' + doc.numPages);
	updateZoomUi();
	drawAllMarks();
	const start = Number.isInteger(init.initialPage) ? init.initialPage : wanted ? wanted.page : 1;
	goToPage(start);
	if (state.find.query) {
		runFind(false);
	}
	measureAllPages(seq);
}

function openFailure(error) {
	const name = error && error.name;
	if (name === 'PasswordException') {
		return 'This PDF is protected by a password, and VSwriter cannot open protected PDFs. Save an unprotected copy and open that.';
	}
	if (name === 'InvalidPDFException') {
		return 'This file could not be read as a PDF. It may be damaged or incomplete.';
	}
	if (name === 'ResponseException') {
		return 'The PDF could not be loaded. It may have been moved or deleted since it was opened.';
	}
	return 'The PDF could not be opened. ' + (error && error.message ? error.message : '');
}

// Most readings use one sheet size. The sizes of the rest are read in the
// background so a mixed PDF settles before the writer scrolls to it.
async function measureAllPages(seq) {
	for (const p of state.pages) {
		if (seq !== state.docSeq) {
			return;
		}
		if (!p.sized) {
			try {
				await proxyFor(p);
			} catch {
				return;
			}
		}
	}
	// Then the ink on each sheet, nearest the page being read first. The fit
	// zoom is settled once the first dozen are known, so the type size stops
	// changing early; later sheets only trim.
	const order = [...state.pages].sort((a, b) => Math.abs(a.n - state.page) - Math.abs(b.n - state.page));
	let measured = 0;
	for (const p of order) {
		if (seq !== state.docSeq) {
			return;
		}
		try {
			p.ink = await inkBox(p);
		} catch {
			p.ink = null;
		}
		if (seq !== state.docSeq) {
			return;
		}
		measured++;
		if (state.fit && (measured === Math.min(12, state.pages.length) || measured === state.pages.length)) {
			refit();
		} else if (state.fit && measured > 12) {
			keepPlace(() => sizePage(p));
		}
	}
}

function setControls(on) {
	for (const node of [ui.pageNumber, ui.zoomOut, ui.zoomIn, ui.zoomFit, ui.findInput, ui.bookmarkToggle]) {
		node.disabled = !on;
	}
	if (!on) {
		ui.pagePrev.disabled = ui.pageNext.disabled = true;
		ui.findPrev.disabled = ui.findNext.disabled = true;
	}
}


/* Painting sheets ----------------------------------------------------- */

let active = null; // the sheet being painted: { p, task }
let pumpTimer = 0;

// Sheets within a screen of the viewport are painted, nearest first, one at
// a time. A sheet far from the one being read gives its canvas back.
const pageWatch = new IntersectionObserver((entries) => {
	for (const entry of entries) {
		const p = pageAt(Number(entry.target.dataset.page));
		if (p) {
			p.near = entry.isIntersecting;
		}
	}
	pump();
}, { root: ui.viewer, rootMargin: '100% 0px 100% 0px' });

const stale = (p) => p.near && (p.paintedScale !== state.scale || p.paintedDpr !== dpr() || p.text === 'none');

function pump() {
	if (active || !state.doc) {
		return;
	}
	let next = null;
	for (const p of state.pages) {
		if (stale(p) && (!next || Math.abs(p.n - state.page) < Math.abs(next.n - state.page))) {
			next = p;
		}
	}
	if (!next) {
		release();
		return;
	}
	active = { p: next, task: null };
	paint(next).catch((error) => {
		if (!error || error.name !== 'RenderingCancelledException') {
			console.error('VSwriter PDF: page ' + next.n + ' could not be painted.', error);
			next.paintedScale = state.scale; // do not retry a failing sheet until the zoom changes
			next.paintedDpr = dpr();
		}
	}).finally(() => {
		active = null;
		pump();
	});
}

function pumpSoon() {
	clearTimeout(pumpTimer);
	pumpTimer = setTimeout(pump, 140);
}

async function paint(p) {
	const seq = state.docSeq;
	const scale = state.scale;
	const ratio = dpr();
	const proxy = await proxyFor(p);
	if (seq !== state.docSeq) {
		return;
	}
	ensureText(p).catch(() => {});
	if (p.paintedScale === scale && p.paintedDpr === ratio) {
		return;
	}

	const viewport = proxy.getViewport({ scale });
	const cssW = Math.floor(p.w * scale);
	const cssH = Math.floor(p.h * scale);
	// One canvas pixel per device pixel, so text is as sharp as the screen
	// allows. A sheet zoomed far enough to pass the cap is painted coarser.
	const out = Math.min(ratio, Math.sqrt(MAX_CANVAS_PIXELS / (cssW * cssH)));
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.round(cssW * out));
	canvas.height = Math.max(1, Math.round(cssH * out));
	const task = proxy.render({
		canvas,
		viewport,
		transform: [canvas.width / viewport.width, 0, 0, canvas.height / viewport.height, 0, 0],
	});
	active.task = task;
	await task.promise;
	if (seq !== state.docSeq) {
		return;
	}
	// Painted off the page and swapped in whole, so a sheet being repainted
	// at a new zoom never shows blank.
	p.sheet.replaceChildren(canvas);
	p.paintedScale = scale;
	p.paintedDpr = ratio;
}

function release() {
	const selection = document.getSelection();
	const range = selection && selection.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
	let dropped = false;
	for (const p of state.pages) {
		const away = Math.abs(p.n - state.page);
		if (p.paintedScale && !p.near && away > KEEP_CANVASES) {
			p.sheet.replaceChildren();
			p.paintedScale = 0;
			p.proxy?.cleanup();
		}
		if (p.text === 'done' && !p.near && away > KEEP_TEXT && !(range && range.intersectsNode(p.textEl))) {
			textEnds.delete(p.textEl);
			p.textEl.replaceChildren();
			p.text = 'none';
			p.textLayer = null;
			p.textReady = null;
			dropped = true;
		}
	}
	if (dropped) {
		paintFind();
	}
}

function ensureItems(p) {
	if (!p.itemsReady) {
		p.itemsReady = proxyFor(p)
			.then((proxy) => proxy.getTextContent())
			.then((content) => {
				p.content = content;
				p.items = content.items.filter((item) => item.str !== undefined);
				return p.items;
			});
		p.itemsReady.catch(() => {
			p.itemsReady = null;
		});
	}
	return p.itemsReady;
}

// The selectable text over a sheet. It is laid out once: PDF.js sizes it from
// --total-scale-factor, so a change of zoom rescales it without a rebuild.
function ensureText(p) {
	if (p.text !== 'none') {
		return p.textReady || Promise.resolve();
	}
	p.text = 'loading';
	const seq = state.docSeq;
	p.textReady = (async () => {
		await ensureItems(p);
		if (seq !== state.docSeq) {
			return;
		}
		const layer = new state.lib.TextLayer({
			textContentSource: p.content,
			container: p.textEl,
			viewport: p.proxy.getViewport({ scale: state.scale }),
		});
		await layer.render();
		if (seq !== state.docSeq) {
			return;
		}
		const end = el('div', 'endOfContent');
		p.textEl.append(end);
		textEnds.set(p.textEl, end);
		p.textLayer = layer;
		p.text = 'done';
		paintFind();
	})();
	p.textReady.catch((error) => {
		console.error('VSwriter PDF: the text of page ' + p.n + ' could not be laid out.', error);
		p.text = 'failed'; // the sheet is still painted; it is not retried
	});
	return p.textReady;
}


/* Zoom ---------------------------------------------------------------- */

function fitRoom() {
	const style = getComputedStyle(ui.viewer);
	return ui.viewer.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2;
}

// Fit fills the width with the body of the reading: the median width of the
// sheets' ink, so a wide cover or table does not shrink every other page.
function fitScale() {
	const inked = state.pages.filter((p) => p.ink).map((p) => p.ink.x1 - p.ink.x0).sort((a, b) => a - b);
	const widest = inked.length ? inked[Math.floor(inked.length / 2)] : Math.max(0, ...state.pages.map((p) => p.w));
	const room = fitRoom();
	if (!widest || room <= 0) {
		return state.scale;
	}
	return clamp(room / widest, 0.25 * CSS_PER_POINT, 4 * CSS_PER_POINT);
}

// Re-apply fit after the ink is known or the frame changes, even when the
// zoom stays the same, since trimming changes the sheets' frames.
function refit() {
	keepPlace(() => {
		state.scale = fitScale();
		for (const p of state.pages) {
			sizePage(p);
		}
	});
	state.zoom = state.scale / CSS_PER_POINT;
	updateZoomUi();
	pumpSoon();
	// Keeping the place above stops a glide to a suggested passage that was
	// under way (opening the notes drawer re-fits the sheets). Aim again.
	if (state.suggest.current >= 0 && Date.now() - state.suggest.revealAt < 2000) {
		revealSuggestion(state.suggest.current);
	}
}

function setScale(scale) {
	if (!state.doc || Math.abs(scale - state.scale) < 0.0005) {
		return;
	}
	// The sheets take their new size at once, the canvases stretched to
	// match, and are repainted sharp a moment after the last change.
	keepPlace(() => {
		state.scale = scale;
		for (const p of state.pages) {
			sizePage(p);
		}
	});
	state.zoom = scale / CSS_PER_POINT;
	if (active && active.task) {
		active.task.cancel();
	}
	updateZoomUi();
	pumpSoon();
	saveState();
}

function zoomStep(direction) {
	if (!state.doc) {
		return;
	}
	const now = state.zoom;
	const next = direction > 0
		? ZOOM_STEPS.find((z) => z > now + 0.005)
		: [...ZOOM_STEPS].reverse().find((z) => z < now - 0.005);
	if (next === undefined) {
		return;
	}
	if (state.fit) {
		state.fit = false;
		keepPlace(() => state.pages.forEach(sizePage)); // whole sheets again
	}
	setScale(next * CSS_PER_POINT);
	updateZoomUi();
	saveState();
}

function fitWidth() {
	if (!state.doc) {
		return;
	}
	state.fit = true;
	refit();
	saveState();
}

function updateZoomUi() {
	ui.zoomLevel.textContent = Math.round(state.zoom * 100) + '%';
	ui.zoomFit.setAttribute('aria-pressed', String(state.fit));
	ui.zoomOut.disabled = !state.doc || state.zoom <= ZOOM_STEPS[0] + 0.005;
	ui.zoomIn.disabled = !state.doc || state.zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1] - 0.005;
}

new ResizeObserver(() => {
	if (state.doc && state.fit) {
		refit();
	}
	pumpSoon(); // the pixel ratio changes with the window's zoom
}).observe(ui.viewer);


/* Which page ---------------------------------------------------------- */

function readPage() {
	const viewer = ui.viewer;
	if (!state.pages.length) {
		return 1;
	}
	if (viewer.scrollTop <= 1) {
		return 1;
	}
	if (viewer.scrollTop + viewer.clientHeight >= viewer.scrollHeight - 2) {
		return state.pages.length;
	}
	const line = viewer.scrollTop + viewer.clientHeight * 0.4;
	for (const p of state.pages) {
		if (p.el.offsetTop + p.el.offsetHeight > line) {
			return p.n;
		}
	}
	return state.pages.length;
}

function setPage(n) {
	if (n !== state.page) {
		state.page = n;
		saveState();
	}
	updatePageUi();
}

function updatePageUi() {
	const count = state.pages.length;
	if (document.activeElement !== ui.pageNumber) {
		ui.pageNumber.value = count ? String(state.page) : '';
	}
	ui.pagePrev.disabled = !count || state.page <= 1;
	ui.pageNext.disabled = !count || state.page >= count;
	updateKeepButtons();
}

// y: where on the page to land, 0 to 1. Left out, the top of the page.
function goToPage(n, y) {
	if (!state.pages.length) {
		return;
	}
	const p = pageAt(clamp(Math.round(n) || 1, 1, state.pages.length));
	const viewer = ui.viewer;
	const top = y === undefined
		? p.el.offsetTop - 6
		: pageY(p, y) - viewer.clientHeight * 0.3;
	viewer.scrollTop = Math.max(0, top);
	state.pinnedTop = viewer.scrollTop;
	setPage(p.n);
	pump();
}

let scrollFrame = 0;
ui.viewer.addEventListener('scroll', () => {
	if (scrollFrame) {
		return;
	}
	scrollFrame = requestAnimationFrame(() => {
		scrollFrame = 0;
		if (Math.abs(ui.viewer.scrollTop - state.pinnedTop) < 1) {
			return;
		}
		state.pinnedTop = -1;
		setPage(readPage());
	});
}, { passive: true });

ui.pagePrev.addEventListener('click', () => goToPage(state.page - 1));
ui.pageNext.addEventListener('click', () => goToPage(state.page + 1));
ui.pageNumber.addEventListener('focus', () => ui.pageNumber.select());
ui.pageNumber.addEventListener('blur', updatePageUi);
ui.pageNumber.addEventListener('keydown', (event) => {
	if (event.key === 'Enter') {
		const n = parseInt(ui.pageNumber.value, 10);
		ui.viewer.focus({ preventScroll: true });
		if (Number.isInteger(n)) {
			goToPage(n);
		}
		updatePageUi();
	} else if (event.key === 'Escape') {
		ui.viewer.focus({ preventScroll: true });
	}
});
ui.zoomOut.addEventListener('click', () => zoomStep(-1));
ui.zoomIn.addEventListener('click', () => zoomStep(1));
ui.zoomFit.addEventListener('click', fitWidth);


/* Highlights on the sheet --------------------------------------------- */

function drawMarks(p) {
	const nodes = [];
	for (const h of state.highlights) {
		if (h.page !== p.n) {
			continue;
		}
		for (const r of h.rects) {
			const mark = el('div', 'mark ink-' + h.color + (h.id === state.currentHighlight ? ' is-current' : ''));
			mark.style.left = r.x * 100 + '%';
			mark.style.top = r.y * 100 + '%';
			mark.style.width = r.w * 100 + '%';
			mark.style.height = r.h * 100 + '%';
			nodes.push(mark);
		}
	}
	p.marks.replaceChildren(...nodes);
}

function drawAllMarks() {
	for (const p of state.pages) {
		if (p.marks.firstChild || state.highlights.some((h) => h.page === p.n)) {
			drawMarks(p);
		}
	}
}

// The highlight under a point on a sheet. The last one saved wins where two overlap.
function highlightAt(p, clientX, clientY) {
	const box = p.sheet.getBoundingClientRect();
	const x = (clientX - box.left) / box.width;
	const y = (clientY - box.top) / box.height;
	for (let i = state.highlights.length - 1; i >= 0; i--) {
		const h = state.highlights[i];
		if (h.page === p.n && h.rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)) {
			return h;
		}
	}
	return null;
}

const pageFromEvent = (event) => {
	const node = event.target instanceof Element ? event.target.closest('.page') : null;
	return node ? pageAt(Number(node.dataset.page)) : null;
};

ui.pages.addEventListener('click', (event) => {
	const selection = document.getSelection();
	if (selection && !selection.isCollapsed) {
		return; // the end of a drag, not a click on a highlight
	}
	const p = pageFromEvent(event);
	const h = p && highlightAt(p, event.clientX, event.clientY);
	if (h) {
		focusHighlight(h.id, true);
	}
});

let hoverFrame = 0;
ui.pages.addEventListener('mousemove', (event) => {
	if (hoverFrame || !state.highlights.length) {
		return;
	}
	hoverFrame = requestAnimationFrame(() => {
		hoverFrame = 0;
		const p = pageFromEvent(event);
		for (const other of ui.pages.querySelectorAll('.over-mark')) {
			if (!p || other !== p.el) {
				other.classList.remove('over-mark');
			}
		}
		if (p) {
			p.el.classList.toggle('over-mark', Boolean(highlightAt(p, event.clientX, event.clientY)));
		}
	});
});

function setCurrentHighlight(id) {
	const pagesToRedraw = new Set();
	for (const h of state.highlights) {
		if (h.id === id || h.id === state.currentHighlight) {
			pagesToRedraw.add(h.page);
		}
	}
	state.currentHighlight = id;
	for (const n of pagesToRedraw) {
		const p = pageAt(n);
		if (p) {
			drawMarks(p);
		}
	}
	for (const [rowId, row] of highlightRows) {
		row.li.classList.toggle('is-current', rowId === id);
	}
}

// From the sheet: open the drawer on this highlight, ready for a note.
function focusHighlight(id, fromSheet) {
	setCurrentHighlight(id);
	const row = highlightRows.get(id);
	if (!row) {
		return;
	}
	if (fromSheet) {
		setDrawer(true);
		row.li.scrollIntoView({ block: 'nearest' });
		row.note.focus({ preventScroll: true });
	}
}


/* Selection ----------------------------------------------------------- */

// The PDF.js viewer's guard against a drag that leaves the text and selects
// the whole sheet: a block that fills the text layer while a selection is
// made and, in Chromium before 148, is moved beside the end of the selection.
const textEnds = new Map(); // text layer element -> its endOfContent element
let pointerDown = false;
let previousRange = null;
let modernSelection;

// Puts a text layer's guard back at rest. It touches the page only when
// there is something to undo: moving a node while a drag is under way makes
// Chromium start the selection again from the pointer.
function resetTextEnd(end, layer) {
	if (layer.lastChild !== end) {
		layer.append(end);
	}
	if (end.style.width || end.style.height) {
		end.style.width = '';
		end.style.height = '';
	}
	layer.classList.remove('selecting');
}

function guardSelection() {
	const selection = document.getSelection();
	if (!selection || selection.rangeCount === 0) {
		textEnds.forEach(resetTextEnd);
		return;
	}
	const range = selection.getRangeAt(0);
	for (const [layer, end] of textEnds) {
		if (!(range.collapsed && !pointerDown) && range.intersectsNode(layer)) {
			layer.classList.add('selecting');
		} else {
			resetTextEnd(end, layer);
		}
	}
	if (modernSelection === undefined) {
		const version = navigator.userAgentData
			? navigator.userAgentData.brands.find((b) => b.brand === 'Chromium')?.version
			: /\bChrome\/(\d+)\b/.exec(navigator.userAgent)?.[1];
		modernSelection = Boolean(version) && parseInt(version, 10) >= 148;
	}
	if (modernSelection) {
		return;
	}
	const modifyStart = previousRange
		&& (range.compareBoundaryPoints(Range.END_TO_END, previousRange) === 0
			|| range.compareBoundaryPoints(Range.START_TO_END, previousRange) === 0);
	let anchor = modifyStart ? range.startContainer : range.endContainer;
	if (anchor.nodeType === Node.TEXT_NODE) {
		anchor = anchor.parentNode;
	}
	if (!modifyStart && range.endOffset === 0) {
		do {
			while (anchor && !anchor.previousSibling) {
				anchor = anchor.parentNode;
			}
			anchor = anchor && anchor.previousSibling;
		} while (anchor && !anchor.childNodes.length);
	}
	const layer = anchor && anchor.parentElement ? anchor.parentElement.closest('.textLayer') : null;
	const end = layer && textEnds.get(layer);
	if (end) {
		end.style.width = layer.style.width;
		end.style.height = layer.style.height;
		end.style.userSelect = 'text';
		anchor.parentElement.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
	}
	previousRange = range.cloneRange();
}

// Only the runs of text can be selected (see .viewer in pdf.css), and the
// leading between two lines of a paragraph belongs to no run: a drag that
// began there would select nothing, about one press in six. Such a drag is
// anchored to the nearest character and carried by hand. A press out in a
// margin is further than half a line from any run and still does nothing.
let gapDrag = null; // { node, offset } while such a drag is under way

function caretIn(span, x, y) {
	const at = document.caretPositionFromPoint
		? document.caretPositionFromPoint(x, y)
		: document.caretRangeFromPoint(x, y);
	const node = at && (at.offsetNode || at.startContainer);
	if (!node || node.parentNode !== span) {
		return null;
	}
	return { node, offset: at.offsetNode ? at.offset : at.startOffset };
}

function nearestCharacter(p, x, y) {
	let best = null;
	let bestGap = Infinity;
	for (const span of p.textEl.children) {
		if (span.nodeName !== 'SPAN' || !span.firstChild) {
			continue;
		}
		const r = span.getBoundingClientRect();
		const gap = Math.max(r.top - y, y - r.bottom, 0);
		if (x >= r.left - 3 && x <= r.right + 3 && gap <= r.height * 0.5 && gap < bestGap) {
			best = { span, r };
			bestGap = gap;
		}
	}
	if (!best) {
		return null;
	}
	const { span, r } = best;
	return caretIn(span, clamp(x, r.left + 0.5, r.right - 0.5), (r.top + r.bottom) / 2);
}

ui.pages.addEventListener('mousedown', (event) => {
	const target = event.target;
	if (event.button !== 0 || event.detail !== 1 || event.shiftKey || !(target instanceof Element)) {
		return;
	}
	const p = target.matches('.textLayer, .endOfContent') ? pageFromEvent(event) : null;
	const at = p && p.text === 'done' ? nearestCharacter(p, event.clientX, event.clientY) : null;
	if (at) {
		event.preventDefault();
		gapDrag = at;
		document.getSelection().collapse(at.node, at.offset);
	}
});

document.addEventListener('mousemove', (event) => {
	if (!gapDrag) {
		return;
	}
	const under = document.elementFromPoint(event.clientX, event.clientY);
	const p = under ? pageAt(Number(under.closest('.page')?.dataset.page)) : null;
	if (!p || p.text !== 'done') {
		return;
	}
	const at = under.parentNode === p.textEl && under.nodeName === 'SPAN'
		? caretIn(under, event.clientX, event.clientY)
		: nearestCharacter(p, event.clientX, event.clientY);
	if (at) {
		document.getSelection().setBaseAndExtent(gapDrag.node, gapDrag.offset, at.node, at.offset);
	}
});

document.addEventListener('mouseup', () => {
	gapDrag = null;
});

// Rectangles from one selected run of text, joined into one flat bar a line.
// Input and output are in pixels: { l, t, r, b }.
function mergeIntoLines(rects) {
	const sorted = rects.slice().sort((a, b) => (a.t + a.b) - (b.t + b.b) || a.l - b.l);
	const lines = [];
	for (const r of sorted) {
		const line = lines[lines.length - 1];
		const overlap = line ? Math.min(line.b, r.b) - Math.max(line.t, r.t) : 0;
		if (line && overlap > 0.5 * Math.min(line.b - line.t, r.b - r.t)) {
			line.parts.push(r);
			line.t = Math.min(line.t, r.t);
			line.b = Math.max(line.b, r.b);
		} else {
			lines.push({ t: r.t, b: r.b, parts: [r] });
		}
	}
	const bars = [];
	for (const line of lines) {
		// A gap wider than the line is tall is a gutter between columns, and
		// stays open. Anything narrower is the space between two words.
		const reach = (line.b - line.t) * 0.9;
		let bar = null;
		for (const r of line.parts.sort((a, b) => a.l - b.l)) {
			if (bar && r.l - bar.r <= reach) {
				bar.r = Math.max(bar.r, r.r);
			} else {
				bar = { l: r.l, t: line.t, r: r.r, b: line.b };
				bars.push(bar);
			}
		}
	}
	// Two lines whose boxes overlap would show a darker band where the ink
	// doubles. The lower edge and the upper edge meet halfway.
	for (let i = 0; i < bars.length; i++) {
		for (let j = i + 1; j < bars.length && bars[j].t < bars[i].b; j++) {
			const a = bars[i];
			const b = bars[j];
			if (b.t > a.t && a.l < b.r && b.l < a.r) {
				const mid = (a.b + b.t) / 2;
				a.b = mid;
				b.t = mid;
			}
		}
	}
	return bars;
}

const round4 = (n) => Math.round(n * 10000) / 10000;

// What the writer selected, a piece for each page it touches: the text with
// its line breaks, and rectangles as fractions of the page so they hold at
// any zoom.
function captureSelection() {
	const selection = document.getSelection();
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
		return null;
	}
	const range = selection.getRangeAt(0);
	if (!ui.pages.contains(range.commonAncestorContainer)) {
		return null;
	}
	const pieces = [];
	for (const p of state.pages) {
		if (p.text !== 'done' || !range.intersectsNode(p.textEl)) {
			continue;
		}
		const box = p.sheet.getBoundingClientRect();
		const walker = document.createTreeWalker(p.textEl, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
		const part = document.createRange();
		const found = [];
		let text = '';
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (node.nodeType === Node.ELEMENT_NODE) {
				if (node.nodeName === 'BR' && text && range.intersectsNode(node)) {
					text += '\n';
				}
				continue;
			}
			if (!range.intersectsNode(node)) {
				continue;
			}
			const from = node === range.startContainer ? range.startOffset : 0;
			const to = node === range.endContainer ? range.endOffset : node.length;
			if (to <= from) {
				continue;
			}
			const chosen = node.data.slice(from, to);
			text += chosen;
			if (!chosen.trim()) {
				continue;
			}
			part.setStart(node, from);
			part.setEnd(node, to);
			for (const r of part.getClientRects()) {
				if (r.width > 0.5 && r.height > 0.5) {
					found.push({ l: r.left - box.left, t: r.top - box.top, r: r.right - box.left, b: r.bottom - box.top });
				}
			}
		}
		text = text.replace(/[ \t]+\n/g, '\n').trim();
		if (!text || !found.length) {
			continue;
		}
		const rects = [];
		for (const bar of mergeIntoLines(found)) {
			const x = clamp(bar.l / box.width, 0, 1);
			const y = clamp(bar.t / box.height, 0, 1);
			const w = clamp(bar.r / box.width, 0, 1) - x;
			const h = clamp(bar.b / box.height, 0, 1) - y;
			if (w > 0 && h > 0) {
				rects.push({ x: round4(x), y: round4(y), w: round4(w), h: round4(h) });
			}
		}
		if (rects.length) {
			pieces.push({ page: p.n, text, rects });
		}
	}
	if (!pieces.length) {
		return null;
	}
	return {
		text: pieces.map((piece) => piece.text).join('\n'),
		page: pieces[0].page,
		lastPage: pieces[pieces.length - 1].page,
		pieces,
	};
}

function setSelection(captured) {
	const same = Boolean(captured && state.selection && captured.text === state.selection.text
		&& captured.page === state.selection.page);
	state.selection = captured;
	if (same) {
		return; // read again after a click on the bar; what the bar says still holds
	}
	keepSheetStill(() => {
		if (!captured) {
			ui.selbar.hidden = true;
			return;
		}
		ui.selPage.textContent = captured.lastPage > captured.page
			? 'p. ' + captured.page + ' to ' + captured.lastPage
			: 'p. ' + captured.page;
		ui.selQuote.textContent = cut(flowText(captured.text), PREVIEW_CHARS);
		ui.selStatus.textContent = '';
		ui.selbar.hidden = false;
	});
}

let selectionTimer = 0;
function readSelectionSoon() {
	clearTimeout(selectionTimer);
	selectionTimer = setTimeout(() => {
		// Choosing a button on the bar must not lose what the bar is about.
		if (ui.selbar.contains(document.activeElement) && state.selection) {
			return;
		}
		setSelection(captureSelection());
	}, 0);
}

document.addEventListener('pointerdown', () => {
	pointerDown = true;
});
document.addEventListener('pointerup', () => {
	pointerDown = false;
	textEnds.forEach(resetTextEnd);
	readSelectionSoon();
});
window.addEventListener('blur', () => {
	pointerDown = false;
	gapDrag = null;
	textEnds.forEach(resetTextEnd);
});
document.addEventListener('keyup', () => {
	if (!pointerDown) {
		textEnds.forEach(resetTextEnd);
	}
});
document.addEventListener('selectionchange', () => {
	guardSelection();
	if (!pointerDown) {
		readSelectionSoon();
	}
});

// A press on the bar would otherwise collapse the selection before the click arrives.
ui.selbar.addEventListener('mousedown', (event) => event.preventDefault());

ui.selbar.addEventListener('click', (event) => {
	const button = event.target instanceof Element ? event.target.closest('button') : null;
	const captured = state.selection;
	if (!button || !captured) {
		return;
	}
	if (button.dataset.ink) {
		for (const piece of captured.pieces) {
			post({
				type: 'addHighlight',
				highlight: { page: piece.page, text: piece.text, note: '', color: button.dataset.ink, rects: piece.rects },
			});
		}
		document.getSelection()?.removeAllRanges();
		setSelection(null);
		ui.viewer.focus({ preventScroll: true });
	} else if (button === ui.selQuoteDraft) {
		post({ type: 'sendToDraft', text: captured.text, page: captured.page, fileName: state.fileName });
		ui.selStatus.textContent = 'Sent to the draft';
	} else if (button === ui.selSourceMap) {
		post({ type: 'appendToSourceMap', text: captured.text, page: captured.page, fileName: state.fileName });
		ui.selStatus.textContent = 'Sent to source-map.md';
	}
});

// Copy gives the passage as running text, without the line breaks of the page.
ui.pages.addEventListener('copy', (event) => {
	const captured = captureSelection();
	if (captured && event.clipboardData) {
		event.clipboardData.setData('text/plain', flowText(captured.text));
		event.preventDefault();
	}
});


/* Bookmarks and the drawer -------------------------------------------- */

const bookmarkOn = (n) => state.bookmarks.find((b) => b.page === n);

function updateKeepButtons() {
	const marked = Boolean(state.doc && bookmarkOn(state.page));
	ui.bookmarkToggle.setAttribute('aria-pressed', String(marked));
	ui.bookmarkWord.textContent = marked ? 'Bookmarked' : 'Bookmark';
	ui.bookmarkRest.textContent = marked ? '' : ' page';
	ui.bookmarkToggle.title = marked
		? 'Remove the bookmark from page ' + state.page + ' (' + MOD_KEY + '+B)'
		: 'Bookmark page ' + state.page + ' (' + MOD_KEY + '+B)';
	const kept = state.highlights.length + state.bookmarks.length;
	ui.drawerToggle.textContent = kept ? 'Notes (' + kept + ')' : 'Notes';
	ui.drawerToggle.title = plural(state.highlights.length, 'highlight', 'highlights') + ', '
		+ plural(state.bookmarks.length, 'bookmark', 'bookmarks');
}

// A bookmark is named by the text selected on the page, or failing that by
// the first line of the page that reads as words.
async function labelFor(n) {
	const selected = state.selection;
	if (selected && selected.page === n) {
		return cut(flowText(selected.text), LABEL_CHARS);
	}
	try {
		const items = await ensureItems(pageAt(n));
		let line = '';
		for (const item of items) {
			line += item.str;
			if (item.hasEOL) {
				if ((line.match(/\p{L}/gu) || []).length >= 4) {
					break;
				}
				line = '';
			}
		}
		line = line.replace(/\s+/g, ' ').trim();
		if (line) {
			return cut(line, LABEL_CHARS);
		}
	} catch {
		// A page whose text cannot be read still gets a bookmark.
	}
	return 'Page ' + n;
}

async function toggleBookmark() {
	if (!state.doc) {
		return;
	}
	const n = state.page;
	const existing = bookmarkOn(n);
	post({ type: 'toggleBookmark', page: n, label: existing ? existing.label : await labelFor(n) });
}

function setDrawer(open) {
	if (ui.drawer.hidden !== open) {
		return;
	}
	ui.drawer.hidden = !open;
	ui.drawerToggle.setAttribute('aria-expanded', String(open));
	saveState();
}

ui.bookmarkToggle.addEventListener('click', toggleBookmark);
ui.drawerToggle.addEventListener('click', () => setDrawer(ui.drawer.hidden));

// Rows are kept by id and updated in place, so a list that is redrawn while
// the writer types a note keeps the field, the caret and the unsaved words.
function reconcile(list, items, rows, build, update) {
	const seen = new Set();
	let previous = null;
	for (const item of items) {
		let row = rows.get(item.id);
		if (!row) {
			row = build(item);
			rows.set(item.id, row);
		}
		update(row, item);
		const wanted = previous ? previous.nextSibling : list.firstChild;
		if (row.li !== wanted) {
			list.insertBefore(row.li, wanted);
		}
		previous = row.li;
		seen.add(item.id);
	}
	for (const [id, row] of rows) {
		if (!seen.has(id)) {
			row.li.remove();
			rows.delete(id);
		}
	}
}

const bookmarkRows = new Map();
const highlightRows = new Map();

function buildBookmarkRow(bookmark) {
	const li = el('li', 'bm');
	const go = el('button', 'row-go');
	go.type = 'button';
	const locator = el('span', 'mono locator');
	const label = el('span', 'bm-label');
	go.append(locator, label);
	const remove = el('button', 'btn-text', 'Remove');
	remove.type = 'button';
	li.append(go, remove);
	const row = { li, go, locator, label, remove, page: bookmark.page };
	go.addEventListener('click', () => goToPage(row.page));
	remove.addEventListener('click', () => post({ type: 'deleteBookmark', id: bookmark.id }));
	return row;
}

function updateBookmarkRow(row, bookmark) {
	row.page = bookmark.page;
	row.locator.textContent = 'p. ' + bookmark.page;
	row.label.textContent = bookmark.label || 'Page ' + bookmark.page;
	row.go.setAttribute('aria-label', 'Go to page ' + bookmark.page + ', ' + row.label.textContent);
	row.remove.setAttribute('aria-label', 'Remove the bookmark on page ' + bookmark.page);
}

function renderBookmarks() {
	reconcile(ui.bookmarks, state.bookmarks, bookmarkRows, buildBookmarkRow, updateBookmarkRow);
	ui.bookmarksTally.textContent = state.bookmarks.length ? String(state.bookmarks.length) : '';
	ui.bookmarksEmpty.hidden = state.bookmarks.length > 0;
}

function buildHighlightRow(highlight) {
	const id = highlight.id;
	const li = el('li', 'hl');
	const go = el('button', 'row-go');
	go.type = 'button';
	const head = el('span', 'hl-head');
	const locator = el('span', 'mono locator');
	const ink = el('span', 'ink-name');
	head.append(locator, ink);
	const excerpt = el('span', 'prose excerpt');
	const passage = el('mark');
	excerpt.append(passage);
	go.append(head, excerpt);

	const note = el('textarea', 'field note-field');
	note.rows = 1;
	note.placeholder = 'Add a note';
	note.spellcheck = true;

	const actions = el('div', 'row-actions');
	const quote = el('button', 'btn-text', 'Quote to draft');
	quote.type = 'button';
	const remove = el('button', 'btn-text', 'Remove');
	remove.type = 'button';
	actions.append(quote, remove);

	// Removing a highlight that carries a note takes a second, deliberate click.
	const confirm = el('div', 'row-actions');
	confirm.hidden = true;
	const ask = el('span', 'ask', 'Remove this highlight and its note?');
	const yes = el('button', 'btn-text', 'Remove both');
	yes.type = 'button';
	const no = el('button', 'btn-text', 'Keep');
	no.type = 'button';
	confirm.append(ask, yes, no);

	li.append(go, note, actions, confirm);
	const row = { li, go, locator, ink, passage, note, quote, remove, saved: highlight.note, data: highlight };

	const saveNote = () => {
		if (note.value !== row.saved) {
			row.saved = note.value;
			post({ type: 'updateHighlightNote', id, note: note.value });
		}
	};
	go.addEventListener('click', () => {
		setCurrentHighlight(id);
		const first = row.data.rects[0];
		goToPage(row.data.page, first ? first.y : 0);
	});
	note.addEventListener('focus', () => setCurrentHighlight(id));
	note.addEventListener('blur', saveNote);
	note.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			saveNote();
			ui.viewer.focus({ preventScroll: true });
		} else if (event.key === 'Escape') {
			note.value = row.saved;
			ui.viewer.focus({ preventScroll: true });
		}
	});
	quote.addEventListener('click', () => {
		post({ type: 'sendToDraft', text: row.data.text, page: row.data.page, fileName: state.fileName });
	});
	remove.addEventListener('click', () => {
		if (note.value.trim()) {
			actions.hidden = true;
			confirm.hidden = false;
			no.focus();
		} else {
			post({ type: 'deleteHighlight', id });
		}
	});
	yes.addEventListener('click', () => post({ type: 'deleteHighlight', id }));
	no.addEventListener('click', () => {
		confirm.hidden = true;
		actions.hidden = false;
		remove.focus();
	});
	row.saveNote = saveNote;
	return row;
}

function updateHighlightRow(row, highlight) {
	row.data = highlight;
	row.locator.textContent = 'p. ' + highlight.page;
	row.ink.textContent = highlight.color;
	row.passage.className = 'ink-' + highlight.color;
	row.passage.textContent = cut(flowText(highlight.text), EXCERPT_CHARS);
	row.go.setAttribute('aria-label', 'Go to the ' + highlight.color + ' highlight on page ' + highlight.page);
	row.note.setAttribute('aria-label', 'Note on the highlight on page ' + highlight.page);
	// Words being typed outrank the copy that came back from the host.
	const editing = document.activeElement === row.note || row.note.value !== row.saved;
	if (!editing) {
		row.note.value = highlight.note;
		row.saved = highlight.note;
	}
	row.li.classList.toggle('is-current', highlight.id === state.currentHighlight);
}

function renderHighlights() {
	reconcile(ui.highlights, state.highlights, highlightRows, buildHighlightRow, updateHighlightRow);
	ui.highlightsTally.textContent = state.highlights.length ? String(state.highlights.length) : '';
	ui.highlightsEmpty.hidden = state.highlights.length > 0;
}

// A note still being typed when the pane is hidden or closed is saved first.
function saveOpenNotes() {
	for (const row of highlightRows.values()) {
		row.saveNote();
	}
}
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'hidden') {
		saveOpenNotes();
	}
});
window.addEventListener('pagehide', saveOpenNotes);


/* Find ---------------------------------------------------------------- */

// One character out for each character in, so an offset in the folded text
// is the same offset in the page's own text.
function foldChar(ch) {
	switch (ch) {
		case '‘': case '’': case '‚': case '′': return "'";
		case '“': case '”': case '„': case '″': return '"';
		case ' ': case ' ': case ' ': return ' ';
		case '‐': case '‑': return '-';
	}
	const lower = ch.toLowerCase();
	return lower.length === 1 ? lower : ch;
}

function fold(text) {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		out += foldChar(text[i]);
	}
	return out;
}

// The page as one searchable string, with the item and offset each character
// came from. A word broken over a line is joined the way flowText joins it.
function searchIndex(p) {
	if (p.search) {
		return p.search;
	}
	const items = p.items;
	let folded = '';
	const item = [];
	const offset = [];
	for (let i = 0; i < items.length; i++) {
		const str = items[i].str;
		const next = i + 1 < items.length ? items[i + 1].str : '';
		const broken = items[i].hasEOL && /\p{Ll}-$/u.test(str) && /^\p{Ll}/u.test(next);
		const length = broken ? str.length - 1 : str.length;
		for (let c = 0; c < length; c++) {
			folded += foldChar(str[c]);
			item.push(i);
			offset.push(c);
		}
		if (items[i].hasEOL && !broken && length && !/\s$/.test(str)) {
			folded += ' ';
			item.push(i);
			offset.push(length - 1);
		}
	}
	p.search = { folded, item, offset };
	return p.search;
}

function queryPattern(query) {
	const escaped = fold(query.trim()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
	return escaped ? new RegExp(escaped, 'g') : null;
}

function setFindTally() {
	const { matches, index, query, capped } = state.find;
	if (!query.trim()) {
		ui.findTally.textContent = '';
	} else if (!matches.length) {
		ui.findTally.textContent = 'No matches';
	} else {
		ui.findTally.textContent = (index + 1) + ' of ' + matches.length + (capped ? '+' : '');
	}
	ui.findPrev.disabled = ui.findNext.disabled = matches.length === 0;
}

// jump: go to the first match at or after the page being read.
async function runFind(jump) {
	const find = state.find;
	const seq = ++find.seq;
	const docSeq = state.docSeq;
	find.query = ui.findInput.value;
	find.matches = [];
	find.index = -1;
	find.capped = false;
	const pattern = queryPattern(find.query);
	if (!pattern || !state.doc) {
		setFindTally();
		paintFind();
		return;
	}
	ui.findTally.textContent = 'Reading';
	const matches = [];
	let anyText = false;
	for (const p of state.pages) {
		try {
			await ensureItems(p);
		} catch {
			continue;
		}
		if (seq !== find.seq || docSeq !== state.docSeq) {
			return;
		}
		const search = searchIndex(p);
		anyText = anyText || search.folded.trim().length > 0;
		pattern.lastIndex = 0;
		for (let m = pattern.exec(search.folded); m && matches.length < MAX_MATCHES; m = pattern.exec(search.folded)) {
			if (!m[0].length) {
				pattern.lastIndex++;
				continue;
			}
			const last = m.index + m[0].length - 1;
			matches.push({
				page: p.n,
				a: search.item[m.index],
				ao: search.offset[m.index],
				b: search.item[last],
				bo: search.offset[last] + 1,
			});
		}
		if (matches.length >= MAX_MATCHES) {
			find.capped = true;
			break;
		}
	}
	find.matches = matches;
	if (matches.length) {
		const from = matches.findIndex((m) => m.page >= state.page);
		find.index = from < 0 ? 0 : from;
	}
	setFindTally();
	if (!matches.length && !anyText) {
		ui.findTally.textContent = 'No text to search';
		ui.findTally.title = 'This PDF holds pictures of pages and no text. It may be a scan.';
	} else {
		ui.findTally.title = '';
	}
	paintFind();
	if (jump && matches.length) {
		showMatch();
	}
}

function matchRange(p, match) {
	const divs = p.textLayer.textDivs;
	const start = divs[match.a] && divs[match.a].firstChild;
	const end = divs[match.b] && divs[match.b].firstChild;
	if (!start || !end || match.ao > start.length || match.bo > end.length) {
		return null;
	}
	const range = document.createRange();
	range.setStart(start, match.ao);
	range.setEnd(end, match.bo);
	return range;
}

// Marks matches with the CSS Custom Highlight API: ranges over the text
// layer, painted by the browser, with nothing added to the page's own nodes.
function paintFind() {
	if (!window.CSS || !CSS.highlights || typeof Highlight !== 'function') {
		return;
	}
	const all = new Highlight();
	const current = new Highlight();
	const { matches, index } = state.find;
	for (let i = 0; i < matches.length; i++) {
		const p = pageAt(matches[i].page);
		if (!p || p.text !== 'done') {
			continue;
		}
		const range = matchRange(p, matches[i]);
		if (range) {
			(i === index ? current : all).add(range);
		}
	}
	CSS.highlights.set('vsw-find', all);
	CSS.highlights.set('vsw-find-current', current);
	paintSuggest();
}

async function showMatch() {
	const find = state.find;
	const match = find.matches[find.index];
	if (!match) {
		return;
	}
	const seq = find.seq;
	const p = pageAt(match.page);
	setFindTally();
	// Land on the page first, then on the line once its text is laid out.
	const viewer = ui.viewer;
	const pageTop = p.el.offsetTop;
	if (pageTop + p.el.offsetHeight < viewer.scrollTop || pageTop > viewer.scrollTop + viewer.clientHeight) {
		goToPage(p.n);
	}
	try {
		await proxyFor(p);
		await ensureText(p);
	} catch {
		return;
	}
	if (seq !== find.seq || find.matches[find.index] !== match || p.text !== 'done') {
		return;
	}
	paintFind();
	const range = matchRange(p, match);
	if (!range) {
		return;
	}
	const rect = range.getBoundingClientRect();
	const frame = viewer.getBoundingClientRect();
	if (rect.top < frame.top + 8 || rect.bottom > frame.bottom - 8) {
		viewer.scrollTop += rect.top - frame.top - viewer.clientHeight * 0.3;
		state.pinnedTop = viewer.scrollTop;
	}
	if (rect.left < frame.left || rect.right > frame.right) {
		viewer.scrollLeft += rect.left - frame.left - 24;
	}
	setPage(p.n);
}

function stepFind(direction) {
	const find = state.find;
	if (ui.findInput.value !== find.query) {
		clearTimeout(findTimer);
		runFind(true);
		return;
	}
	if (!find.matches.length) {
		return;
	}
	find.index = (find.index + direction + find.matches.length) % find.matches.length;
	showMatch();
}

let findTimer = 0;
ui.findInput.addEventListener('input', () => {
	clearTimeout(findTimer);
	findTimer = setTimeout(() => runFind(true), 180);
});
ui.findInput.addEventListener('keydown', (event) => {
	if (event.key === 'Enter') {
		event.preventDefault();
		stepFind(event.shiftKey ? -1 : 1);
	} else if (event.key === 'Escape') {
		event.preventDefault();
		clearTimeout(findTimer);
		ui.findInput.value = '';
		runFind(false);
		ui.viewer.focus({ preventScroll: true });
	}
});
ui.findPrev.addEventListener('click', () => stepFind(-1));
ui.findNext.addEventListener('click', () => stepFind(1));


/* Keyboard ------------------------------------------------------------ */

// Listening in the capture phase and stopping a handled key keeps it from
// VS Code, which would also act on it (Cmd+B hides the side bar).
window.addEventListener('keydown', (event) => {
	const target = event.target instanceof Element ? event.target : null;
	const typing = Boolean(target && (target.closest('input, textarea, select') || target.isContentEditable));
	const mod = event.metaKey || event.ctrlKey;
	const key = event.key;
	let handled = true;

	if (mod && !event.altKey && !event.shiftKey && key.toLowerCase() === 'f') {
		if (!ui.findInput.disabled) {
			ui.findInput.focus();
			ui.findInput.select();
		}
	} else if (mod && !event.altKey && !event.shiftKey && key.toLowerCase() === 'b') {
		toggleBookmark();
	} else if (typing || mod || event.altKey || !state.doc) {
		handled = false;
	} else if ((key === ' ' || key === 'Enter') && target && target.closest('button')) {
		handled = false; // the button's own press
	} else if (key === 'ArrowLeft' || key === 'PageUp') {
		goToPage(state.page - 1);
	} else if (key === 'ArrowRight' || key === 'PageDown') {
		goToPage(state.page + 1);
	} else if (key === '+' || key === '=') {
		zoomStep(1);
	} else if (key === '-' || key === '_') {
		zoomStep(-1);
	} else if (key === 'Home') {
		goToPage(1);
	} else if (key === 'End') {
		goToPage(state.pages.length);
	} else if (key === 'ArrowDown' || key === 'ArrowUp') {
		ui.viewer.scrollTop += key === 'ArrowDown' ? 60 : -60;
	} else if (key === ' ') {
		ui.viewer.scrollTop += (event.shiftKey ? -0.9 : 0.9) * ui.viewer.clientHeight;
	} else if (key === 'Escape' && state.currentHighlight) {
		setCurrentHighlight('');
	} else {
		handled = false;
	}

	if (handled) {
		event.preventDefault();
		event.stopPropagation();
	}
}, true);


/* Host ---------------------------------------------------------------- */

window.addEventListener('message', (event) => {
	const message = event.data;
	if (!message || typeof message.type !== 'string') {
		return;
	}
	if (message.type === 'pdfInit' && typeof message.pdfUri === 'string') {
		const fileName = typeof message.fileName === 'string' ? message.fileName : 'PDF';
		setData(message.highlights, message.bookmarks);
		if (state.doc && state.uri === message.pdfUri) {
			state.fileName = fileName;
			if (Number.isInteger(message.initialPage)) {
				goToPage(message.initialPage);
			}
		} else if (state.opening === message.pdfUri) {
			state.fileName = fileName;
		} else {
			openDocument({ pdfUri: message.pdfUri, fileName, initialPage: message.initialPage });
		}
	} else if (message.type === 'pdfData') {
		setData(message.highlights, message.bookmarks);
	} else if (message.type === 'pdfGoToPage' && Number.isFinite(message.page)) {
		goToPage(message.page);
	} else if (message.type === 'pdfExtractText' && Number.isFinite(message.reqId)) {
		pageTexts().then((pages) => post({ type: 'pdfText', reqId: message.reqId, pages }));
	} else if (message.type === 'pdfSuggest' && Array.isArray(message.items)) {
		showSuggestions(message.items);
	}
});

/* Companion: passages for the paragraph being written --------------------- */

// Page text the way search reads it, with words broken over a line rejoined.
async function pageTexts() {
	const out = [];
	for (const p of state.pages) {
		try {
			const items = await ensureItems(p);
			let text = '';
			for (let i = 0; i < items.length; i++) {
				const str = items[i].str;
				const next = i + 1 < items.length ? items[i + 1].str : '';
				const broken = items[i].hasEOL && /\p{Ll}-$/u.test(str) && /^\p{Ll}/u.test(next);
				text += broken ? str.slice(0, -1) : str;
				if (items[i].hasEOL && !broken && !/\s$/.test(str)) {
					text += ' ';
				}
			}
			out.push(text);
		} catch {
			out.push('');
		}
	}
	return out;
}

function showSuggestions(items) {
	ui.suggestions.replaceChildren();
	for (const item of items) {
		const li = el('li', 'hl suggestion');
		const go = el('button', 'row-go');
		go.type = 'button';
		const head = el('span', 'hl-head');
		head.append(el('span', 'mono locator', 'p. ' + item.page), el('span', 'stance stance-' + item.stance, item.stance === 'supports' ? 'Supports' : 'Complicates'));
		const excerpt = el('span', 'prose excerpt');
		excerpt.append(el('mark', '', item.quote));
		go.append(head, excerpt, el('span', 'why', item.why));
		const index = ui.suggestions.children.length;
		go.addEventListener('click', () => revealSuggestion(index));
		const actions = el('div', 'row-actions');
		const quote = el('button', 'btn-text', 'Quote to draft');
		quote.type = 'button';
		quote.addEventListener('click', () => post({ type: 'sendToDraft', text: item.quote, page: item.page, fileName: state.fileName }));
		actions.append(quote);
		li.append(go, actions);
		ui.suggestions.append(li);
	}
	state.suggest.items = items;
	state.suggest.current = -1;
	locateSuggestions(items).then(() => {
		// Glide to the first passage unless the writer is reading the PDF right now.
		if (items.length && Date.now() - state.suggest.touched > 8000) {
			revealSuggestion(0);
		}
	});
	ui.suggestTally.textContent = items.length ? String(items.length) : '';
	ui.suggest.hidden = items.length === 0;
	if (items.length) {
		ui.drawer.hidden = false;
		ui.drawerToggle.setAttribute('aria-expanded', 'true');
	}
}

// Where each suggested quote sits in the text layer, found like a search.
async function locateSuggestions(items) {
	const seq = ++state.suggest.seq;
	const matches = [];
	for (let i = 0; i < items.length; i++) {
		const p = pageAt(items[i].page);
		const pattern = queryPattern(items[i].quote);
		if (!p || !pattern) {
			continue;
		}
		try {
			await ensureItems(p);
		} catch {
			continue;
		}
		if (seq !== state.suggest.seq) {
			return;
		}
		const search = searchIndex(p);
		const m = pattern.exec(search.folded);
		if (m && m[0].length) {
			const last = m.index + m[0].length - 1;
			matches[i] = { page: p.n, a: search.item[m.index], ao: search.offset[m.index], b: search.item[last], bo: search.offset[last] + 1 };
		}
	}
	state.suggest.matches = matches;
	paintSuggest();
}

// Suggested passages stay marked on the sheet; the chosen one is stronger.
function paintSuggest() {
	if (!window.CSS || !CSS.highlights || typeof Highlight !== 'function') {
		return;
	}
	const all = new Highlight();
	const current = new Highlight();
	state.suggest.matches.forEach((m, i) => {
		const p = m && pageAt(m.page);
		const range = p && p.text === 'done' ? matchRange(p, m) : null;
		if (range) {
			(i === state.suggest.current ? current : all).add(range);
		}
	});
	CSS.highlights.set('vsw-suggest', all);
	CSS.highlights.set('vsw-suggest-current', current);
}

function glideTo(top) {
	const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
	ui.viewer.scrollTo({ top: Math.max(0, top), behavior: still ? 'auto' : 'smooth' });
	pumpSoon();
}

// Glide to the page, then settle the passage a third of the way down once
// its text layer is laid out.
async function revealSuggestion(i) {
	const item = state.suggest.items[i];
	const match = state.suggest.matches[i];
	const p = item && pageAt(match ? match.page : item.page);
	if (!p) {
		return;
	}
	state.suggest.current = i;
	state.suggest.revealAt = Date.now();
	[...ui.suggestions.children].forEach((row, n) => row.classList.toggle('is-current', n === i));
	paintSuggest();
	const viewer = ui.viewer;
	glideTo(p.el.offsetTop - 6);
	if (!match) {
		return;
	}
	try {
		await proxyFor(p);
		await ensureText(p);
	} catch {
		return;
	}
	if (state.suggest.current !== i || p.text !== 'done') {
		return;
	}
	paintSuggest();
	const range = matchRange(p, match);
	if (range) {
		const rect = range.getBoundingClientRect();
		const frame = viewer.getBoundingClientRect();
		glideTo(viewer.scrollTop + rect.top - frame.top - viewer.clientHeight * 0.3);
	}
	setPage(p.n);
}

for (const type of ['wheel', 'pointerdown', 'keydown']) {
	ui.viewer.addEventListener(type, () => { state.suggest.touched = Date.now(); }, { passive: true });
}

const kept = vscode.getState();
if (kept && typeof kept === 'object') {
	state.wanted = { uri: kept.uri, page: kept.page, zoom: kept.zoom, fit: kept.fit };
	if (kept.drawer) {
		ui.drawer.hidden = false;
		ui.drawerToggle.setAttribute('aria-expanded', 'true');
	}
}
ui.findInput.title = 'Find in this PDF (' + MOD_KEY + '+F). Enter goes to the next match, Shift+Enter to the one before.';
updateKeepButtons();
post({ type: 'pdfReady' });
