/* Code blocks: long lines scroll sideways, as the theme has them, or wrap.
   Per block, with a toggle floating over the top-right corner the way the
   mermaid and diff blocks carry theirs, and the reader's last choice kept as
   the default for blocks built after it.

   The block is wrapped here, in the browser, rather than by a markdown-it
   plugin: nothing about the served HTML changes, so a running daemon needs
   no restart, and every other feature already knows what to do with the
   result. The wrapper carries data-marker-wrapper, so comments.js puts
   thread widgets after the whole block instead of among its controls, and
   it is deliberately not data-marker-ui, or the code inside would stop
   being commentable. The toggle is data-marker-ui, which keeps its text out
   of the quote corpus, and user-select: none, because a drag along the
   first line ends exactly where it floats.

   The toggle shows only where it means something: on a block whose lines
   actually run past its edge, or one already wrapped, since that one has to
   be able to go back. Every block carrying a button was tried and read as
   noise. Blocks inside another feature's wrapper — a mermaid diagram's
   source, a diff block's unified view — are left to that feature. */
(function () {
	'use strict';

	var KEY = 'markserv-marker-code-lines'; // 'scroll' (default) | 'wrap'
	// Per block, by ordinal among the document's code blocks, because a hot
	// reload replaces #marker-content wholesale. Memory only; the stored key
	// is the default a block resolves to when it is built.
	var modes = {};

	function el(tag, className, text) {
		var node = document.createElement(tag);
		if (className) node.className = className;
		if (text) node.textContent = text;
		node.setAttribute('data-marker-ui', '');
		return node;
	}

	function content() {
		return document.getElementById('marker-content');
	}

	function preferred() {
		try {
			return localStorage.getItem(KEY) === 'wrap' ? 'wrap' : 'scroll';
		} catch (_) {
			return 'scroll';
		}
	}

	function remember(mode) {
		try {
			localStorage.setItem(KEY, mode);
		} catch (_) {}
	}

	// Every code block that is nobody else's, wrapped or not yet
	function blocks() {
		var root = content();
		if (!root) return [];
		return [].filter.call(root.querySelectorAll('pre'), function (pre) {
			if (pre.closest('[data-marker-ui]')) return false;
			var wrapper = pre.closest('[data-marker-wrapper]');
			return !wrapper || wrapper.classList.contains('marker-codeblock');
		});
	}

	function wrapperOf(pre) {
		var parent = pre.parentElement;
		if (parent && parent.classList.contains('marker-codeblock')) return parent;

		var wrapper = document.createElement('div');
		wrapper.className = 'marker-codeblock';
		wrapper.setAttribute('data-marker-wrapper', '');
		parent.insertBefore(wrapper, pre);
		wrapper.appendChild(pre);
		return wrapper;
	}

	function toggleOf(wrapper, index) {
		var existing = wrapper.querySelector('.marker-codeblock-toggle');
		if (existing) return existing;

		var button = el('button', 'marker-codeblock-toggle');
		button.type = 'button';
		button.appendChild(el('span', 'marker-codeblock-toggle-label'));
		button.addEventListener('click', function () {
			var next = wrapper.getAttribute('data-mode') === 'wrap' ? 'scroll' : 'wrap';
			modes[index] = next;
			// The default for blocks built later; the ones on the page keep
			// the mode they resolved to
			remember(next);
			applyModes();
			// Wrapping changes the block's height, and what sits below it
			// moves: the sticky headers and pinned widgets follow a resize
			window.dispatchEvent(new Event('resize'));
		});
		wrapper.appendChild(button);
		return button;
	}

	function paint(wrapper) {
		var button = wrapper.querySelector('.marker-codeblock-toggle');
		var pre = wrapper.querySelector('pre');
		if (!button || !pre) return;

		var wraps = wrapper.getAttribute('data-mode') === 'wrap';
		// The label says which way the lines are shown, not what the button
		// does — read as an action it looks like a state, and mistaking the
		// two costs more than the wording saves. The action is the tooltip.
		var label = button.querySelector('.marker-codeblock-toggle-label');
		if (label) label.textContent = wraps ? '↩ wrap' : '↔ scroll';
		button.title = wraps ?
			'Long lines wrap. Click to scroll them sideways instead.' :
			'Long lines scroll sideways. Click to wrap them.';

		// Only where it means something: a block whose lines run past its
		// edge, or one already wrapped, which has to be able to go back.
		// Measured in scroll mode; wrapped, there is nothing to measure.
		var overflows = pre.scrollWidth > pre.clientWidth + 1;
		button.hidden = !wraps && !overflows;
	}

	function applyModes() {
		blocks().forEach(function (pre, index) {
			var wrapper = pre.closest('.marker-codeblock');
			if (!wrapper) return;
			wrapper.setAttribute('data-mode', modes[index] === 'wrap' ? 'wrap' : 'scroll');
			paint(wrapper);
		});
	}

	function renderAll() {
		blocks().forEach(function (pre, index) {
			var wrapper = wrapperOf(pre);
			toggleOf(wrapper, index);
			if (modes[index] === undefined) modes[index] = preferred();
		});
		applyModes();
	}

	var pending = null;

	function applySoon() {
		if (pending) clearTimeout(pending);
		pending = setTimeout(function () {
			pending = null;
			applyModes();
		}, 120);
	}

	document.addEventListener('marker:reload', renderAll);
	// Whether a block overflows depends on the width it was given
	window.addEventListener('resize', applySoon);

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', renderAll);
	} else {
		renderAll();
	}
})();
