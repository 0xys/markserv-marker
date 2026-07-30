/* Mermaid blocks for markserv-marker markdown pages.
   lib/mermaid.js renders a ```mermaid fence as .marker-mermaid wrapping the
   ordinary <pre><code> for its source. This script draws the diagram beside it
   and adds a button that switches the block between the two. Comments are made
   on the source, so the code view is where the comment UI works; the button
   carries a badge when the block has unresolved comments.

   Everything created here is marked data-marker-ui. That is not cosmetic:
   comments.js collects every text node under #marker-content to match quotes
   against, and diagram labels leaking into that corpus would shift the
   occurrence counting for the whole document. The wrapper itself is left
   unmarked on purpose — marking it would make its source uncommentable.

   The diagram is progressive enhancement. The server emits no data-mode, CSS
   shows the source by default, and the mode attribute only appears once a
   render has actually succeeded. */
(function () {
	'use strict';

	var LIB_URL = '{markserv}vendor/mermaid.min.js';

	// Page theme -> mermaid theme
	var THEMES = {dark: 'dark', synthwave: 'dark', solarized: 'neutral', light: 'default'};

	// Per-block view mode, keyed by the block's ordinal position among the
	// mermaid blocks of the document. Hot reload replaces #marker-content
	// wholesale, so anything kept on the elements themselves is lost; the
	// ordinal survives edits to the prose around the diagrams.
	var modes = {};
	var seq = 0;
	var libState = 0; // 0 not loaded, 1 loading, 2 ready, 3 failed
	var waiting = [];

	function content() {
		return document.getElementById('marker-content');
	}

	function blocks() {
		var root = content();
		return root ? [].slice.call(root.querySelectorAll('.marker-mermaid')) : [];
	}

	function pageTheme() {
		return document.documentElement.getAttribute('data-theme') || 'dark';
	}

	function el(tag, className) {
		var node = document.createElement(tag);
		if (className) node.className = className;
		node.setAttribute('data-marker-ui', '');
		return node;
	}

	/* ---------- the mermaid bundle ---------- */

	// Around 3.5 MB, so it is fetched only once a page turns out to have a
	// mermaid block — which cannot be decided server-side, since hot reload
	// swaps the content without reloading the page.
	function ensureLib(callback) {
		if (window.mermaid) {
			libState = 2;
			callback();
			return;
		}

		if (libState === 3) return;
		waiting.push(callback);
		if (libState === 1) return;
		libState = 1;

		var script = document.createElement('script');
		script.src = LIB_URL;
		script.async = true;
		script.onload = function () {
			libState = 2;
			var queued = waiting;
			waiting = [];
			queued.forEach(function (fn) {
				fn();
			});
		};
		script.onerror = function () {
			// Every block stays in code view, which is readable on its own
			libState = 3;
			waiting = [];
		};
		document.head.appendChild(script);
	}

	function initLib() {
		if (!window.mermaid) return;
		window.mermaid.initialize({
			startOnLoad: false,
			securityLevel: 'strict',
			suppressErrorRendering: true,
			theme: THEMES[pageTheme()] || 'dark',
			// SVG labels instead of foreignObject: HTML labels would inherit the
			// github-markdown theme's rules for p/div/table.
			// No fontFamily override — mermaid sizes each box by measuring its
			// label, and a font it cannot resolve while measuring gives boxes
			// too narrow for the text they end up holding.
			flowchart: {htmlLabels: false}
		});
	}

	/* ---------- rendering ---------- */

	function sourceOf(wrapper) {
		var code = wrapper.querySelector('.marker-mermaid-source code');
		// textContent, not innerHTML: comment highlights inject <mark> in here
		return code ? code.textContent : '';
	}

	function toggleOf(wrapper, index) {
		var existing = wrapper.querySelector('.marker-mermaid-toggle');
		if (existing) return existing;

		var button = el('button', 'marker-mermaid-toggle');
		button.appendChild(el('span', 'marker-mermaid-toggle-label'));
		button.addEventListener('click', function () {
			modes[index] = wrapper.getAttribute('data-mode') === 'code' ? 'diagram' : 'code';
			applyModes();
		});
		wrapper.appendChild(button);
		return button;
	}

	function paintToggle(wrapper, index) {
		var button = wrapper.querySelector('.marker-mermaid-toggle');
		if (!button) return;

		var showsCode = wrapper.getAttribute('data-mode') === 'code';
		var label = button.querySelector('.marker-mermaid-toggle-label');
		if (label) label.textContent = showsCode ? '🖼️ diagram' : '</> code';
		button.title = showsCode ?
			'Show the rendered diagram' :
			'Show the mermaid source, where comments can be made';

		// Unresolved threads are the reason to go and read the source, so their
		// count rides on the button. Counted from the highlights comments.js
		// left behind rather than fetched again — one thread can own several.
		var ids = {};
		var marks = wrapper.querySelectorAll('mark.marker-quote:not(.resolved)');
		for (var i = 0; i < marks.length; i++) {
			ids[marks[i].getAttribute('data-thread-id')] = 1;
		}

		var count = Object.keys(ids).length;
		var badge = button.querySelector('.marker-mermaid-count');
		if (count === 0) {
			if (badge) badge.remove();
			return;
		}

		if (!badge) {
			badge = el('span', 'marker-mermaid-count');
			button.appendChild(badge);
		}

		badge.textContent = count;
		badge.title = count + ' unresolved comment' + (count > 1 ? 's' : '');
	}

	function applyModes() {
		blocks().forEach(function (wrapper, index) {
			// Blocks whose diagram never rendered have no mode and stay as source
			if (!wrapper.querySelector('.marker-mermaid-diagram')) return;
			wrapper.setAttribute('data-mode', modes[index] === 'code' ? 'code' : 'diagram');
			paintToggle(wrapper, index);
		});
	}

	function showError(wrapper, error) {
		var existing = wrapper.querySelector('.marker-mermaid-error');
		if (existing) existing.remove();
		var node = el('div', 'marker-mermaid-error');
		node.textContent = '⚠ ' + ((error && error.message) || 'mermaid could not render this diagram');
		wrapper.appendChild(node);
	}

	function renderBlock(wrapper, index) {
		var source = sourceOf(wrapper);
		if (!source.trim()) return Promise.resolve();

		// A fresh id every time: mermaid namespaces its marker and arrowhead
		// defs by it, so reusing one collides with the SVG being replaced.
		// Taken now, not inside the callback, where the shared counter has
		// already moved on to the other blocks of this pass.
		seq++;
		var id = 'marker-mermaid-svg-' + seq;
		return Promise.resolve()
			.then(function () {
				return window.mermaid.render(id, source);
			})
			.then(function (result) {
				// A hot reload during the await leaves this wrapper detached
				if (!wrapper.isConnected) return;
				var stale = wrapper.querySelector('.marker-mermaid-error');
				if (stale) stale.remove();

				var diagram = wrapper.querySelector('.marker-mermaid-diagram');
				if (!diagram) {
					diagram = el('div', 'marker-mermaid-diagram');
					wrapper.appendChild(diagram);
				}

				diagram.innerHTML = result.svg;
				if (result.bindFunctions) result.bindFunctions(diagram);
				toggleOf(wrapper, index);
			})
			.catch(function (error) {
				if (!wrapper.isConnected) return;
				var diagram = wrapper.querySelector('.marker-mermaid-diagram');
				if (diagram) diagram.remove();
				wrapper.removeAttribute('data-mode');
				showError(wrapper, error);
			});
	}

	function renderAll() {
		var all = blocks();
		if (all.length === 0) return;

		ensureLib(function () {
			initLib();
			var pending = all.map(function (wrapper, index) {
				return renderBlock(wrapper, index);
			});
			Promise.all(pending).then(applyModes);
		});
	}

	/* ---------- wiring ---------- */

	document.addEventListener('marker:reload', renderAll);
	// Widgets and highlights have just been rebuilt: refresh the badges
	document.addEventListener('marker:rendered', applyModes);
	document.addEventListener('marker:theme', function () {
		if (libState !== 2) return;
		initLib();
		renderAll();
	});

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', renderAll);
	} else {
		renderAll();
	}
})();
