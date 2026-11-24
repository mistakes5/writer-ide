// VSwriter assistant chat and launcher. Talks to the extension with
// { type: 'chatSend' | 'launch' } and renders { type: 'chat' } messages.
(function () {
	'use strict';
	const vscode = window.vscodeApi || (window.vscodeApi = acquireVsCodeApi());
	const $ = (id) => document.getElementById(id);
	const log = $('chat-log');
	const input = $('chat-input');
	const send = $('chat-send');
	let shown = 0;
	let busy = false;

	function bubble(role, text, extra) {
		const li = document.createElement('li');
		li.className = 'msg msg-' + role + (extra ? ' ' + extra : '');
		const p = document.createElement('p');
		p.className = role === 'writer' ? 'prose' : 'voice';
		p.textContent = text;
		li.appendChild(p);
		return li;
	}

	function render(m) {
		busy = m.busy;
		// Rebuild only when the conversation changed, so a new message slides in.
		const key = JSON.stringify(m.turns) + m.busy;
		if (key !== log.dataset.key) {
			log.dataset.key = key;
			log.replaceChildren();
			m.turns.forEach((t, i) => {
				// While a reply is on its way, the last assistant turn is the old question: show typing instead.
				if (m.busy && i === m.turns.length - 1) { return; }
				log.appendChild(bubble(t.role, t.text, i >= shown ? 'is-new' : ''));
			});
			if (m.busy) {
				const typing = bubble('assistant', '', 'is-typing is-new');
				typing.firstChild.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
				typing.setAttribute('aria-label', 'The assistant is writing');
				log.appendChild(typing);
			}
			shown = m.turns.length;
			// After layout, so the newest message is fully in view; a first render jumps, later ones glide.
			const glide = log.dataset.seen && !matchMedia('(prefers-reduced-motion: reduce)').matches;
			log.dataset.seen = '1';
			requestAnimationFrame(() => log.scrollTo({ top: log.scrollHeight, behavior: glide ? 'smooth' : 'auto' }));
		}
		const brief = $('brief');
		brief.hidden = !m.brief;
		$('brief-list').replaceChildren(...(m.brief || '').split('\n').map((line) => line.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean).map((line) => {
			const li = document.createElement('li');
			li.textContent = line;
			return li;
		}));
		$('chat-error').hidden = !m.error;
		$('chat-error').textContent = m.error || '';
		send.disabled = busy;
	}

	window.addEventListener('message', (event) => {
		if (event.data && event.data.type === 'chat') { render(event.data); }
	});

	$('composer').addEventListener('submit', (event) => {
		event.preventDefault();
		const text = input.value;
		if (!text.trim() || busy) { return; }
		vscode.postMessage({ type: 'chatSend', text });
		input.value = '';
	});
	input.addEventListener('keydown', (event) => {
		// Enter sends; Shift+Enter starts a new line.
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			$('composer').requestSubmit();
		}
	});

	$('mind-map').addEventListener('click', () => vscode.postMessage({ type: 'mindMap' }));

	for (const button of document.querySelectorAll('[data-launch]')) {
		button.addEventListener('click', () => vscode.postMessage({ type: 'launch', what: button.dataset.launch }));
	}
})();
