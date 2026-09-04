/* Markdown HTML comments, subtly visible, for markserv-marker pages.
   The server passes <!-- ... --> through markdown-it verbatim, so the browser
   receives real DOM comment nodes — invisible to the reader. Authors use them
   as review notes, so this script makes each one softly visible in place and
   adds a page button that hides them again (persisted in localStorage).

   The comment node itself is left in the DOM untouched; a span is inserted
   right after it, holding the note as a real text node so it can be selected
   and copied. The span is marked data-marker-ui, which keeps the note out of
   the quote-matching corpus (so quoteIndex counting for existing threads
   never shifts) and keeps a selection made inside it from spawning the
   Comment button. A selection that straddles a note does put the note's text
   into the quote, which then matches nothing at read time — the thread still
   anchors to its lines, just without a highlight. The <!-- --> delimiters are
   drawn by CSS pseudo-elements, so copied text is the note alone.

   Hiding is pure CSS: a class on <body>, which sits outside #marker-content
   and therefore survives hot reload swapping the content wholesale. */
(function () {
	'use strict';

	var KEY = 'markserv-marker-md-comments'; // '0' = hidden, absent/'1' = shown
	var HIDDEN_CLASS = 'marker-md-comments-hidden';

	function content() {
		return document.getElementById('marker-content');
	}

	function hidden() {
		return localStorage.getItem(KEY) === '0';
	}

	function commentNodes() {
		var root = content();
		if (!root) return [];
		var walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT, null, false);
		var nodes = [];
		var node;
		while ((node = walker.nextNode())) {
			// Injected UI (a rendered mermaid SVG, say) can hold comment nodes of
			// its own; those are chrome, not the author's notes.
			var parent = node.parentElement || node.parentNode;
			if (parent && parent.closest && parent.closest('[data-marker-ui]')) continue;
			if (!node.nodeValue || node.nodeValue.trim() === '') continue;
			nodes.push(node);
		}

		return nodes;
	}

	/* ---------- decorations ---------- */

	function decorate() {
		var root = content();
		if (!root) return;

		// Idempotent rebuild: marker:reload swaps the content (dropping the old
		// spans with it), but decorate() must also be safe to call on a page
		// that is already decorated.
		var stale = root.querySelectorAll('.marker-md-comment');
		for (var i = 0; i < stale.length; i++) {
			stale[i].remove();
		}

		var nodes = commentNodes();
		nodes.forEach(function (node) {
			var span = document.createElement('span');
			span.className = 'marker-md-comment';
			span.setAttribute('data-marker-ui', '');
			span.textContent = node.nodeValue;
			node.parentNode.insertBefore(span, node.nextSibling);
		});

		ensureButton(nodes.length > 0);
	}

	/* ---------- the toggle ---------- */

	// A small toggle at the right end of the strip above the page frame
	// (laid out by markserv.css), not among the bottom-right page buttons:
	// it matters only to documents that carry comments, so it appears with
	// them and takes no permanent chrome. It lives on the <article>, outside
	// #marker-content, and therefore survives hot reload.
	function paintButton(button) {
		button.textContent = hidden() ? 'show <!-- -->' : 'hide <!-- -->';
		button.title = hidden() ?
			'Show the markdown comments of this document' :
			'Hide the markdown comments of this document';
		button.classList.toggle('is-off', hidden());
	}

	function ensureButton(hasComments) {
		var button = document.getElementById('md-comment-toggle');
		if (!hasComments) {
			if (button) button.remove();
			return;
		}

		if (button) {
			paintButton(button);
			return;
		}

		var article = document.querySelector('article.markdown-body');
		if (!article) return;

		button = document.createElement('button');
		button.className = 'marker-md-toggle';
		button.id = 'md-comment-toggle';
		button.setAttribute('data-marker-ui', '');
		button.addEventListener('click', function () {
			localStorage.setItem(KEY, hidden() ? '1' : '0');
			applyHidden();
			paintButton(button);
		});
		article.appendChild(button);
		paintButton(button);
	}

	function applyHidden() {
		document.body.classList.toggle(HIDDEN_CLASS, hidden());
	}

	/* ---------- wiring ---------- */

	document.addEventListener('marker:reload', decorate);

	function init() {
		applyHidden();
		decorate();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
