// VSwriter sidebar panel. Plain DOM, no framework, no build step.
//
// The extension host owns all data and sends it whole in a 'state' message
// (see src/shared/protocol.ts). This file draws that state and posts the
// writer's actions back. Text from the workspace is only ever placed with
// textContent, never parsed as HTML.

(function () {
	'use strict';

	const vscode = window.vscodeApi = acquireVsCodeApi(); // shared with chat.js: the API can be acquired once

	const TABS = ['interview', 'outline', 'bookmarks', 'lint'];
	const SAVE_WAIT_MS = 5000;
	const COPIED_MS = 1600;
	const MAX_STANCES = 3;        // sentence openers offered under the question
	const MAX_CONTEXT = 2;        // reading passages shown above the answer field
	const CONTEXT_CHARS = 180;    // longest excerpt shown there before it is cut
	const NO_HEADING = '(Opening)'; // the host's name for paragraphs above the first heading

	// What the webview itself remembers between hide and show: the open tab and
	// any unsaved answer, so a half-written answer survives closing the sidebar.
	const kept = vscode.getState() || {};
	const view = {
		tab: TABS.indexOf(kept.tab) >= 0 ? kept.tab : 'interview',
		draft: typeof kept.draft === 'string' ? kept.draft : '',
		draftPrompt: typeof kept.draftPrompt === 'string' ? kept.draftPrompt : ''
	};

	let state = null;    // last 'state' message, normalised
	let pending = null;  // an answer sent to the host and awaiting confirmation
	let keepTimer = 0;
	const drawn = {};    // last data drawn per region, to skip needless redraws


	// Small helpers -------------------------------------------------------

	function $(id) {
		return document.getElementById(id);
	}

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) { node.className = className; }
		if (text !== undefined) { node.textContent = text; }
		return node;
	}

	function clear(node) {
		while (node.firstChild) { node.removeChild(node.firstChild); }
	}

	function str(value) {
		return typeof value === 'string' ? value : '';
	}

	function num(value, fallback) {
		return typeof value === 'number' && isFinite(value) ? value : fallback;
	}

	function records(value) {
		return Array.isArray(value) ? value.filter(function (item) { return item && typeof item === 'object'; }) : [];
	}

	function post(message) {
		vscode.postMessage(message);
	}

	function keep() {
		vscode.setState({ tab: view.tab, draft: view.draft, draftPrompt: view.draftPrompt });
	}

	function keepSoon() {
		clearTimeout(keepTimer);
		keepTimer = setTimeout(keep, 250);
	}

	// True when this region's data differs from what is already on screen.
	function changed(region, data) {
		const json = JSON.stringify(data);
		if (drawn[region] === json) { return false; }
		drawn[region] = json;
		return true;
	}

	function baseName(path) {
		const parts = path.split(/[\\/]/);
		return parts[parts.length - 1] || path;
	}

	function plural(count, one, many) {
		return count + ' ' + (count === 1 ? one : many);
	}

	function formatTime(timestamp) {
		const date = new Date(timestamp);
		if (!timestamp || isNaN(date.getTime())) { return timestamp; }
		return date.toLocaleString(undefined, {
			day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit'
		});
	}


	// Incoming state ------------------------------------------------------

	function bookmarkOf(b) {
		return {
			id: str(b.id), author: str(b.author), year: str(b.year), page: str(b.page),
			filePath: str(b.filePath), line: num(b.line, 1),
			excerpt: str(b.excerpt), reason: str(b.reason), score: num(b.score, 0)
		};
	}

	function count(value) {
		return Math.max(0, Math.round(num(value, 0)));
	}

	function strings(value) {
		return Array.isArray(value) ? value.filter(function (s) { return typeof s === 'string' && s.trim() !== ''; }) : [];
	}

	// questionContext, outline and skeletons arrived in 0.2. A host that leaves
	// any of them out gets the 0.1 panel: the regions they feed stay hidden.
	function normalise(message) {
		const coaxing = message.coaxing && typeof message.coaxing === 'object' ? message.coaxing : {};
		const context = message.questionContext && typeof message.questionContext === 'object' ? message.questionContext : {};
		return {
			workspaceReady: message.workspaceReady === true,
			activeFile: str(message.activeFile) || null,
			currentQuestion: str(message.currentQuestion),
			rawAnswers: records(message.rawAnswers).map(function (a) {
				return { id: str(a.id), timestamp: str(a.timestamp), prompt: str(a.prompt), text: str(a.text) };
			}),
			bookmarks: records(message.bookmarks).map(bookmarkOf),
			questionContext: {
				question: str(context.question),
				options: records(context.options).map(function (o) {
					return { label: str(o.label).trim() || str(o.seed).trim(), seed: str(o.seed) };
				}).filter(function (o) { return o.seed.trim() !== ''; }).slice(0, MAX_STANCES),
				featuredBookmarks: records(context.featuredBookmarks).map(bookmarkOf)
					.filter(function (b) { return b.excerpt.trim() !== '' && b.filePath !== ''; }).slice(0, MAX_CONTEXT)
			},
			outline: records(message.outline).map(function (p, at) {
				return {
					index: count(num(p.index, at + 1)), line: Math.max(1, count(num(p.line, 1))),
					heading: str(p.heading).trim() === NO_HEADING ? '' : str(p.heading).trim(), preview: str(p.preview).trim(),
					words: count(p.words), distinctSources: count(p.distinctSources), quoteCount: count(p.quoteCount),
					hasCounterMove: p.hasCounterMove === true,
					gaps: strings(p.gaps), matchedAnswerIds: strings(p.matchedAnswerIds)
				};
			}),
			skeletons: records(message.skeletons).map(function (s) {
				return { id: str(s.id), label: str(s.label).trim() || str(s.id), description: str(s.description).trim() };
			}).filter(function (s) { return s.id !== ''; }),
			coaxing: {
				heading: str(coaxing.heading),
				starters: Array.isArray(coaxing.starters) ? coaxing.starters.filter(function (s) { return typeof s === 'string' && s; }) : [],
				basedOnAnswerId: str(coaxing.basedOnAnswerId) || null
			},
			diagnostics: records(message.diagnostics).map(function (d) {
				return {
					line: num(d.line, 1), col: num(d.col, 1),
					severity: d.severity === 'error' || d.severity === 'info' ? d.severity : 'warning',
					code: str(d.code), message: str(d.message), excerpt: str(d.excerpt)
				};
			})
		};
	}

	window.addEventListener('message', function (event) {
		const message = event.data;
		if (!message || message.type !== 'state') { return; }
		state = normalise(message);
		confirmSave();
		render();
	});


	// Saving an answer ----------------------------------------------------
	//
	// The protocol has no acknowledgement message, so the textarea is cleared
	// only once the saved text shows up in rawAnswers. Until then the writer's
	// words stay where they typed them.

	function setAnswerStatus(text) {
		$('answer-status').textContent = text;
	}

	function saveAnswer() {
		const input = $('answer');
		const text = input.value;
		if (!state || !state.workspaceReady || pending) { return; }
		if (text.trim() === '') {
			setAnswerStatus('Write an answer first.');
			input.focus();
			return;
		}
		pending = { text: text, count: state.rawAnswers.length, timer: 0 };
		pending.timer = setTimeout(saveUnconfirmed, SAVE_WAIT_MS);
		$('save-answer').disabled = true;
		setAnswerStatus('Saving');
		post({ type: 'submitAnswer', prompt: view.draftPrompt || state.currentQuestion, text: text });
	}

	function confirmSave() {
		if (!pending || state.rawAnswers.length <= pending.count) { return; }
		const wanted = pending.text.trim();
		const found = state.rawAnswers.some(function (a) { return a.text.trim() === wanted; });
		if (!found) { return; }

		const input = $('answer');
		if (input.value === pending.text) {
			input.value = '';
			view.draft = '';
			view.draftPrompt = '';
			keep();
		}
		clearTimeout(pending.timer);
		pending = null;
		$('save-answer').disabled = false;
		setAnswerStatus('Saved to raw-answers.md as typed.');
	}

	function saveUnconfirmed() {
		if (!pending) { return; }
		pending = null;
		$('save-answer').disabled = false;
		setAnswerStatus('VSwriter has yet to confirm the save. Your text is still here. Check raw-answers.md before saving again.');
	}

	function onDraftInput() {
		const value = $('answer').value;
		// A draft belongs to the question it was started under, even if the
		// writer moves to the next question before saving it.
		if (value === '') {
			view.draftPrompt = '';
		} else if (!view.draftPrompt && state) {
			view.draftPrompt = state.currentQuestion;
		}
		view.draft = value;
		if (!pending) { setAnswerStatus(''); }
		renderDraftNote();
		keepSoon();
	}


	// Stances -------------------------------------------------------------
	//
	// A stance is a sentence opener for the current question. Choosing one puts
	// it in the answer field and leaves the cursor after it, so the writer's
	// first act is to finish a sentence. The panel still writes none of it.

	// The text the answer field holds after a stance is chosen. An empty field
	// takes the opener. A field with words keeps every one of them and gets the
	// opener on a new line. Choosing the stance that already ends the field
	// adds nothing.
	function seeded(current, seed) {
		const opener = /\s$/.test(seed) ? seed : seed + ' ';
		if (current.trim() === '') { return opener; }
		const tail = seed.trim();
		if (current.replace(/\s+$/, '').slice(-tail.length) === tail) { return current; }
		return current + (/\n$/.test(current) ? '' : '\n') + opener;
	}

	function useStance(seed) {
		const input = $('answer');
		input.value = seeded(input.value, seed);
		onDraftInput();
		// Kept at once: this click may be the last thing before the sidebar is hidden.
		clearTimeout(keepTimer);
		keep();
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
		input.scrollTop = input.scrollHeight;
	}


	// Tabs ----------------------------------------------------------------

	function selectTab(name, moveFocus) {
		view.tab = name;
		TABS.forEach(function (tab) {
			const button = $('tab-' + tab);
			const selected = tab === name;
			button.setAttribute('aria-selected', selected ? 'true' : 'false');
			button.tabIndex = selected ? 0 : -1;
			$('panel-' + tab).hidden = !selected;
			if (selected && moveFocus) { button.focus(); }
		});
		$('main').scrollTop = 0;
		keep();
	}

	function onTabKey(event) {
		const at = TABS.indexOf(view.tab);
		let to = -1;
		if (event.key === 'ArrowRight') { to = (at + 1) % TABS.length; }
		else if (event.key === 'ArrowLeft') { to = (at + TABS.length - 1) % TABS.length; }
		else if (event.key === 'Home') { to = 0; }
		else if (event.key === 'End') { to = TABS.length - 1; }
		if (to < 0) { return; }
		event.preventDefault();
		selectTab(TABS[to], true);
	}


	// Drawing -------------------------------------------------------------

	function render() {
		renderFrame();
		renderInterview();
		renderOutline();
		renderSkeletons();
		renderBookmarks();
		renderCues();
		renderFlags();
	}

	function renderFrame() {
		const ready = state.workspaceReady;
		// The assistant creates the workflow files itself on the first message.
		$('setup').hidden = true;
		$('interview-body').hidden = true;
		$('bookmarks-body').hidden = false;
		$('coax').hidden = false;

		$('status-workspace').textContent = ready ? 'Workflow files ready' : 'Files start with your first message';
		const file = $('status-file');
		file.textContent = state.activeFile ? baseName(state.activeFile) : 'No draft open';
		file.title = state.activeFile || '';

		// The Outline count is the number of paragraphs that still have a gap.
		const open = state.outline.filter(function (p) { return p.gaps.length > 0; }).length;
		$('count-outline').textContent = open ? String(open) : '';
		$('tab-outline').title = open ? plural(open, 'paragraph has', 'paragraphs have') + ' a gap' : '';
		$('count-bookmarks').textContent = ready && state.bookmarks.length ? String(state.bookmarks.length) : '';
		$('count-lint').textContent = state.diagnostics.length ? String(state.diagnostics.length) : '';
	}

	function renderInterview() {
		const question = $('question');
		const has = state.currentQuestion !== '';
		question.textContent = has ? state.currentQuestion : 'No question is queued. Choose Next question to continue.';
		question.classList.toggle('is-empty', !has);
		renderStances();
		renderContext();
		renderDraftNote();

		const answers = state.rawAnswers;
		if (!changed('answers', answers)) { return; }

		$('answers-count').textContent = answers.length ? String(answers.length) : '';
		$('answers-empty').hidden = answers.length > 0;
		const list = $('answers');
		clear(list);
		// Newest first: the answer just saved is the one the writer looks for.
		for (let i = answers.length - 1; i >= 0; i--) {
			const answer = answers[i];
			const item = el('li');
			const time = el('time', 'mono answer-time', formatTime(answer.timestamp));
			time.dateTime = answer.timestamp;
			item.appendChild(time);
			if (answer.prompt) { item.appendChild(el('p', 'answer-prompt', answer.prompt)); }
			item.appendChild(el('p', 'prose answer-text', answer.text));
			list.appendChild(item);
		}
	}

	function renderDraftNote() {
		const note = $('draft-note');
		const moved = !!state && view.draft !== '' && view.draftPrompt !== '' && view.draftPrompt !== state.currentQuestion;
		note.hidden = !moved;
		note.textContent = moved ? 'This text was started under an earlier question and will be saved with it: ' + view.draftPrompt : '';
	}

	// "17" is a printed page; "PDF 9" is a position in the PDF and stays labelled as one.
	function pageLabel(page) {
		const p = page.trim();
		if (p === '') { return ''; }
		if (/^(\d+|[ivxlcdm]+)$/i.test(p)) { return 'p. ' + p; }
		const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(p);
		if (range) { return 'pp. ' + range[1] + '–' + range[2]; }
		const pdf = /^pdf\s*(?:page|p\.?)?\s*(\d+)$/i.exec(p);
		if (pdf) { return 'PDF p. ' + pdf[1]; }
		return p;
	}

	function locator(year, page) {
		const parts = [year.trim(), pageLabel(page)].filter(Boolean);
		return parts.length ? '(' + parts.join(': ') + ')' : '';
	}

	function citation(bookmark) {
		return [bookmark.author || baseName(bookmark.filePath), locator(bookmark.year, bookmark.page)].filter(Boolean).join(' ');
	}

	// Cuts a long passage at a word boundary and marks the cut.
	function shorten(text, max) {
		const flat = text.replace(/\s+/g, ' ').trim();
		if (flat.length <= max) { return flat; }
		let cut = flat.slice(0, max);
		const space = cut.lastIndexOf(' ');
		if (space > max * 0.6) { cut = cut.slice(0, space); }
		return cut.replace(/[\s,;:.(\[\u2013\u2014-]+$/, '') + '\u2026';
	}

	function renderStances() {
		const options = state.questionContext.options;
		if (!changed('stances', options)) { return; }

		$('stances').hidden = options.length === 0;
		const list = $('stance-list');
		clear(list);
		options.forEach(function (option) {
			const button = el('button', 'btn btn-stance', option.label);
			button.type = 'button';
			button.title = 'Starts your answer with: ' + option.seed.trim();
			button.addEventListener('click', function () { useStance(option.seed); });
			list.appendChild(button);
		});
	}

	// One or two passages for the current question, shown where the writer is
	// already looking. The Bookmarks tab keeps the full list and the reasons.
	function renderContext() {
		const featured = state.questionContext.featuredBookmarks;
		if (!changed('context', featured)) { return; }

		$('context').hidden = featured.length === 0;
		const list = $('context-list');
		clear(list);
		featured.forEach(function (bookmark) {
			const item = el('li');
			const cited = citation(bookmark);

			const head = el('div', 'context-head');
			head.appendChild(el('span', 'context-cite', cited));
			const open = el('button', 'btn-text', 'Open');
			open.type = 'button';
			open.title = bookmark.filePath + ':' + bookmark.line;
			open.setAttribute('aria-label', 'Open beside draft: ' + cited);
			open.addEventListener('click', function () {
				post({ type: 'openReading', filePath: bookmark.filePath, line: bookmark.line });
			});
			head.appendChild(open);
			item.appendChild(head);

			item.appendChild(el('blockquote', 'prose excerpt', shorten(bookmark.excerpt, CONTEXT_CHARS)));
			list.appendChild(item);
		});
	}


	// Outline ---------------------------------------------------------------
	//
	// One row per paragraph of the open draft: what it holds (words, sources,
	// quotations, saved answers it draws on), how it opens, and what it still
	// lacks. A row goes to its paragraph.

	function renderOutline() {
		const rows = state.outline;
		const file = state.activeFile;
		if (!changed('outline', [rows, file])) { return; }

		const words = rows.reduce(function (sum, row) { return sum + row.words; }, 0);
		$('outline-tally').textContent = rows.length ? plural(words, 'word', 'words') : '';

		const empty = $('outline-empty');
		empty.hidden = rows.length > 0;
		empty.textContent = file
			? 'No paragraphs in ' + baseName(file) + ' yet. Each paragraph you write is listed here with its sources and quotations.'
			: 'Open a Markdown draft to see its outline.';

		const list = $('outline');
		clear(list);
		// Paragraph numbers are shown from 1 whichever way the host counts them.
		const shift = rows.some(function (row) { return row.index === 0; }) ? 1 : 0;
		let heading = '';
		rows.forEach(function (row) {
			const item = el('li');
			if (row.heading && row.heading !== heading) { item.appendChild(el('h3', 'outline-heading', row.heading)); }
			heading = row.heading;

			const number = row.index + shift;
			const answers = row.matchedAnswerIds.length;
			const button = el('button', 'outline-row');
			button.type = 'button';
			button.title = 'Line ' + row.line;

			const meta = el('span', 'outline-meta');
			meta.appendChild(el('span', 'outline-index', 'P' + number));
			meta.appendChild(el('span', '', row.words + 'w'));
			meta.appendChild(el('span', '', row.distinctSources + ' src'));
			meta.appendChild(el('span', '', plural(row.quoteCount, 'quote', 'quotes')));
			if (answers) { meta.appendChild(el('span', '', plural(answers, 'answer', 'answers'))); }
			button.appendChild(meta);

			if (row.preview) { button.appendChild(el('span', 'prose outline-preview', row.preview)); }
			if (row.gaps.length) { button.appendChild(el('span', 'outline-gaps', row.gaps.join(', '))); }

			button.setAttribute('aria-label', [
				'Go to paragraph ' + number + ', line ' + row.line,
				[plural(row.words, 'word', 'words'), plural(row.distinctSources, 'source', 'sources'),
					plural(row.quoteCount, 'quotation', 'quotations')]
					.concat(answers ? [plural(answers, 'saved answer', 'saved answers')] : []).join(', '),
				row.gaps.length ? 'Still to add: ' + row.gaps.join(', ') : '',
				row.preview
			].filter(Boolean).join('. '));
			button.addEventListener('click', function () {
				post({ type: 'jumpLine', line: row.line });
			});

			item.appendChild(button);
			list.appendChild(item);
		});
	}

	// A skeleton is a set of labelled slots for one paragraph. It goes into the
	// draft only when the writer asks for it, and the slots hold no prose.
	function renderSkeletons() {
		const skeletons = state.skeletons;
		const canInsert = !!state.activeFile;
		if (!changed('skeletons', [skeletons, canInsert])) { return; }

		$('skeletons-section').hidden = skeletons.length === 0;
		$('skeletons-note').textContent = canInsert
			? 'Insert places labelled slots after the paragraph your cursor is in. You replace each slot with your own sentence.'
			: 'Open a Markdown draft to insert a skeleton.';

		const list = $('skeletons');
		clear(list);
		skeletons.forEach(function (skeleton) {
			const item = el('li', 'skeleton');
			item.appendChild(el('p', 'skeleton-label', skeleton.label));
			if (skeleton.description) { item.appendChild(el('p', 'skeleton-desc', skeleton.description)); }

			const insert = el('button', 'btn', 'Insert');
			insert.type = 'button';
			insert.disabled = !canInsert;
			insert.setAttribute('aria-label', 'Insert skeleton: ' + skeleton.label);
			insert.addEventListener('click', function () {
				post({ type: 'insertSkeleton', skeletonId: skeleton.id });
			});
			item.appendChild(insert);
			list.appendChild(item);
		});
	}


	// Bookmarks -------------------------------------------------------------

	function renderBookmarks() {
		const bookmarks = state.bookmarks;
		const hasAnswers = state.rawAnswers.length > 0;
		if (!changed('bookmarks', [bookmarks, hasAnswers])) { return; }

		const empty = $('bookmarks-empty');
		empty.hidden = bookmarks.length > 0;
		empty.textContent = hasAnswers
			? 'No passage in your readings matched your answers. Check that the readings folder is set, then refresh.'
			: 'Bookmarks come from your saved answers. Save one under Interview, then refresh.';

		const list = $('bookmarks');
		clear(list);
		bookmarks.forEach(function (bookmark) {
			const item = el('li');

			const cite = el('p', 'cite');
			cite.appendChild(el('span', 'cite-author', bookmark.author || baseName(bookmark.filePath)));
			const where = locator(bookmark.year, bookmark.page);
			if (where) { cite.appendChild(el('span', 'cite-locator', where)); }
			item.appendChild(cite);

			item.appendChild(el('blockquote', 'prose excerpt', bookmark.excerpt));
			if (bookmark.reason) { item.appendChild(el('p', 'reason', bookmark.reason)); }

			const foot = el('div', 'bookmark-foot');
			const path = el('span', 'mono source-path');
			path.title = bookmark.filePath + ':' + bookmark.line;
			path.appendChild(el('span', 'source-name', baseName(bookmark.filePath)));
			path.appendChild(el('span', '', ':' + bookmark.line));
			foot.appendChild(path);
			const open = el('button', 'btn', 'Open beside draft');
			open.type = 'button';
			open.addEventListener('click', function () {
				post({ type: 'openReading', filePath: bookmark.filePath, line: bookmark.line });
			});
			foot.appendChild(open);
			item.appendChild(foot);

			list.appendChild(item);
		});
	}

	function renderCues() {
		const coaxing = state.coaxing;
		const basis = coaxing.basedOnAnswerId
			? state.rawAnswers.filter(function (a) { return a.id === coaxing.basedOnAnswerId; })[0]
			: null;
		const hasAnswers = state.rawAnswers.length > 0;
		if (!changed('cues', [coaxing, basis ? basis.timestamp : '', hasAnswers])) { return; }

		const heading = $('coax-heading');
		heading.hidden = coaxing.heading === '' || coaxing.starters.length === 0;
		heading.textContent = coaxing.heading;

		const basisNote = $('coax-basis');
		basisNote.hidden = !basis || coaxing.starters.length === 0;
		basisNote.textContent = basis ? 'Built from your answer saved ' + formatTime(basis.timestamp) + '.' : '';

		const empty = $('coax-empty');
		empty.hidden = coaxing.starters.length > 0;
		empty.textContent = hasAnswers
			? 'No cues yet. Refresh cues to build them from your latest answer.'
			: 'Cues are built from your saved answers. Save one under Interview first.';
		$('refresh-coax').disabled = !hasAnswers;

		const list = $('starters');
		clear(list);
		coaxing.starters.forEach(function (starter) {
			const item = el('li', 'starter');
			item.appendChild(el('p', 'prose', starter));
			const copy = el('button', 'btn-text', 'Copy cue');
			copy.type = 'button';
			copy.addEventListener('click', function () { copyCue(starter, copy); });
			item.appendChild(copy);
			list.appendChild(item);
		});
	}

	function copyCue(text, button) {
		copyText(text).then(function () {
			button.textContent = 'Copied';
		}, function () {
			button.textContent = 'Copy failed';
		}).then(function () {
			setTimeout(function () { button.textContent = 'Copy cue'; }, COPIED_MS);
		});
	}

	function copyText(text) {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			return navigator.clipboard.writeText(text).catch(function () { return copyBySelection(text); });
		}
		return copyBySelection(text);
	}

	function copyBySelection(text) {
		const holder = el('textarea', 'visually-hidden');
		holder.value = text;
		holder.setAttribute('readonly', '');
		document.body.appendChild(holder);
		holder.select();
		let copied = false;
		try { copied = document.execCommand('copy'); } catch (error) { copied = false; }
		document.body.removeChild(holder);
		return copied ? Promise.resolve() : Promise.reject(new Error('copy failed'));
	}


	// Flags ---------------------------------------------------------------
	//
	// One heading per kind of flag, with a sentence saying what the flag is,
	// then the places it occurs. The linter's own message says what to do about
	// it. Codes are those of src/core/slopLinter.ts; a code this table has never
	// seen still gets a readable heading and its message.

	const FLAG_KINDS = {
		'negative-parallelism': {
			title: 'Negative parallelism',
			what: 'A sentence that raises one claim in order to dismiss it and land on another.'
		},
		'hedge-verb': {
			title: 'Vague reporting verbs',
			what: 'A verb such as "suggests" or "aligns with" that leaves open what the source does.'
		},
		'em-dash': {
			title: 'Dashes',
			what: 'A dash standing where the link between two thoughts should be stated.'
		},
		'semicolon': {
			title: 'Semicolons in prose',
			what: 'Two sentences sharing one. Semicolons inside a citation are left alone.'
		},
		'ai-vocabulary': {
			title: 'Stock vocabulary',
			what: 'Words that turn up in machine-written prose far more often than in speech.'
		},
		'self-commentary': {
			title: 'Self-commentary',
			what: 'A closing clause that comments on the claim it follows.'
		},
		'abstract-recasting': {
			title: 'Abstract recasting',
			what: 'A person or event renamed as an abstraction ("X becomes a Y").'
		},
		'wide-page-range': {
			title: 'Wide page ranges',
			what: 'A citation that covers so many pages a reader cannot find the claim.'
		},
		'unverified-quote': {
			title: 'Quotations missing from your readings',
			what: 'Words in quotation marks that VSwriter could not find in the readings it has indexed.'
		}
	};

	const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };
	const SEVERITY_WORDS = { error: ['error', 'errors'], warning: ['warning', 'warnings'], info: ['note', 'notes'] };

	function flagKind(code) {
		if (Object.prototype.hasOwnProperty.call(FLAG_KINDS, code)) { return FLAG_KINDS[code]; }
		const words = code.replace(/[-_.]+/g, ' ').trim();
		return { title: words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Other flags', what: '' };
	}

	function groupFlags(diagnostics) {
		const byCode = {};
		const groups = [];
		diagnostics.forEach(function (diagnostic) {
			let group = byCode[diagnostic.code];
			if (!group) {
				group = byCode[diagnostic.code] = { kind: flagKind(diagnostic.code), items: [], worst: 2 };
				groups.push(group);
			}
			group.items.push(diagnostic);
			group.worst = Math.min(group.worst, SEVERITY_RANK[diagnostic.severity]);
		});
		groups.forEach(function (group) {
			group.items.sort(function (a, b) { return a.line - b.line || a.col - b.col; });
		});
		groups.sort(function (a, b) { return a.worst - b.worst || a.items[0].line - b.items[0].line; });
		return groups;
	}

	function tally(items) {
		return ['error', 'warning', 'info'].map(function (severity) {
			const count = items.filter(function (d) { return d.severity === severity; }).length;
			return count ? plural(count, SEVERITY_WORDS[severity][0], SEVERITY_WORDS[severity][1]) : '';
		}).filter(Boolean).join(', ');
	}

	function renderFlags() {
		const diagnostics = state.diagnostics;
		const file = state.activeFile;
		if (!changed('flags', [diagnostics, file])) { return; }

		const fileLabel = $('flags-file');
		fileLabel.textContent = file ? baseName(file) : '';
		fileLabel.title = file || '';

		const empty = $('flags-empty');
		empty.hidden = diagnostics.length > 0;
		empty.textContent = file ? 'No flags in ' + baseName(file) + '.' : 'Open a Markdown draft to check it.';

		const host = $('diagnostics');
		clear(host);
		groupFlags(diagnostics).forEach(function (group) {
			const section = el('section', 'flag-group');

			const head = el('div', 'flag-head');
			head.appendChild(el('h3', '', group.kind.title));
			head.appendChild(el('span', 'flag-tally sev-' + ['error', 'warning', 'info'][group.worst], tally(group.items)));
			section.appendChild(head);

			if (group.kind.what) { section.appendChild(el('p', 'flag-explain', group.kind.what)); }

			// When every flag in the group carries the same advice, give it once
			// under the heading and let the rows show only the text they point at.
			const advice = group.items[0].message;
			const shared = group.items.every(function (d) { return d.message === advice; });
			if (shared && advice) { section.appendChild(el('p', 'flag-advice', advice)); }

			const list = el('ul');
			group.items.forEach(function (diagnostic) {
				const row = el('button', 'flag');
				row.type = 'button';
				row.title = 'Line ' + diagnostic.line + ', column ' + diagnostic.col;
				row.setAttribute('aria-label', 'Go to line ' + diagnostic.line + ': ' + (diagnostic.excerpt || diagnostic.message));
				row.appendChild(el('span', 'flag-line', String(diagnostic.line)));

				const body = el('span');
				if (diagnostic.excerpt) { body.appendChild(el('span', 'prose flag-excerpt', diagnostic.excerpt)); }
				if (diagnostic.message && (!shared || !diagnostic.excerpt)) {
					body.appendChild(el('span', 'flag-message', diagnostic.message));
				}
				row.appendChild(body);

				row.addEventListener('click', function () {
					post({ type: 'jumpDiagnostic', line: diagnostic.line });
				});
				const item = el('li');
				item.appendChild(row);
				list.appendChild(item);
			});
			section.appendChild(list);
			host.appendChild(section);
		});
	}


	// Wiring --------------------------------------------------------------

	TABS.forEach(function (tab) {
		const button = $('tab-' + tab);
		button.addEventListener('click', function () { selectTab(tab, false); });
		button.addEventListener('keydown', onTabKey);
	});

	const answerInput = $('answer');
	answerInput.value = view.draft;
	answerInput.addEventListener('input', onDraftInput);
	answerInput.addEventListener('keydown', function (event) {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			saveAnswer();
		}
	});

	if (!/Mac|iPhone|iPad/.test(navigator.platform)) {
		$('save-key').textContent = 'Ctrl+Enter';
	}

	$('save-answer').addEventListener('click', saveAnswer);
	$('next-question').addEventListener('click', function () { post({ type: 'nextQuestion' }); });
	$('init-workspace').addEventListener('click', function () { post({ type: 'initWorkspace' }); });
	$('refresh-bookmarks').addEventListener('click', function () { post({ type: 'refreshBookmarks' }); });
	$('refresh-coax').addEventListener('click', function () { post({ type: 'generateCoax' }); });

	selectTab(view.tab, false);
	post({ type: 'ready' });
})();
