/* Selection-anchored comment UI for markserv-marker.
   Loaded only on registered-file pages (window.__marker is injected by the
   markdown template). Select text -> a floating "Comment" button appears ->
   the comment is posted with the enclosing source-line range plus the
   selected text as `quote`, which is highlighted in the page. Rebuilds
   itself on marker:reload / marker:comments events (hot reload replaces the
   content DOM), preserving in-progress drafts. */
(function () {
	'use strict';

	var cfg = window.__marker;
	if (!cfg || !cfg.fileId) return;

	var API = cfg.apiBase + '/files/' + cfg.fileId + '/comments';
	var AUTHOR_KEY = 'markserv-marker-author';
	var QUOTE_MAX = 1000;

	var VIEW_KEY = 'markserv-marker-view';

	var state = {
		// Which of our textareas the reader is in, and their caret in it
		focused: null,
		caret: {},
		threads: [],
		drafts: {},     // draftKey -> {text, lineStart, lineEnd, quote}
		openForms: {},  // draftKey -> true (form should be open after rebuild)
		collapsed: {},  // threadId -> user override (default: resolved => collapsed)
		revealed: {},   // threadId -> true (thread opened by clicking its mark, in 'mark' mode)
		editor: null,   // {lineStart, lineEnd, base, text, anchorLine, disk} while an editor is open
		viewMode: localStorage.getItem(VIEW_KEY) || 'all' // 'all' | 'open' | 'mark' | 'off'
	};

	/* ---------- helpers ---------- */

	function el(tag, className, text) {
		var node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function getAuthor() {
		var author = localStorage.getItem(AUTHOR_KEY);
		if (!author) {
			author = window.prompt('Your name for comments:', '') || '';
			author = author.trim();
			if (author) localStorage.setItem(AUTHOR_KEY, author);
		}
		return author;
	}

	function fmtTime(iso) {
		try {
			return new Date(iso).toLocaleString();
		} catch (err) {
			return iso;
		}
	}

	function api(method, url, body) {
		return fetch(url, {
			method: method,
			headers: body ? {'content-type': 'application/json'} : undefined,
			body: body ? JSON.stringify(body) : undefined
		}).then(function (response) {
			if (response.status === 204) return null;
			return response.json().then(function (data) {
				if (!response.ok) {
					var error = new Error((data && data.error && data.error.message) || ('HTTP ' + response.status));
					error.status = response.status;
					if (data && data.error) error.code = data.error.code;
					// A refused edit answers with the text that is there now;
					// the editor shows it rather than only the message
					if (data && data.current !== undefined) error.current = data.current;
					throw error;
				}
				return data;
			});
		});
	}

	function content() {
		return document.getElementById('marker-content');
	}

	/* ---------- line anchoring ---------- */

	function blockOf(domNode) {
		var node = domNode.nodeType === Node.ELEMENT_NODE ? domNode : domNode.parentElement;
		if (!node) return null;
		if (node.closest('[data-marker-ui]')) return null;
		var block = node.closest('[data-source-line]');
		var root = content();
		if (!block || !root || !root.contains(block)) return null;
		return block;
	}

	function lineRangeOf(block) {
		return {
			start: parseInt(block.getAttribute('data-source-line'), 10),
			end: parseInt(block.getAttribute('data-source-line-end') || block.getAttribute('data-source-line'), 10)
		};
	}

	function candidates() {
		var root = content();
		if (!root) return [];
		var nodes = root.querySelectorAll('[data-source-line]');
		var out = [];
		for (var i = 0; i < nodes.length; i++) {
			if (nodes[i].closest('[data-marker-ui]')) continue;
			var range = lineRangeOf(nodes[i]);
			out.push({node: nodes[i], start: range.start, end: range.end});
		}
		return out;
	}

	// Smallest enclosing range wins; deeper node wins ties
	function anchorFor(line) {
		var best = null;
		var all = candidates();
		for (var i = 0; i < all.length; i++) {
			var c = all[i];
			if (c.start <= line && line <= c.end) {
				var size = c.end - c.start;
				if (!best || size < (best.end - best.start) ||
					(size === (best.end - best.start) && c.node.compareDocumentPosition(best.node) & Node.DOCUMENT_POSITION_PRECEDING)) {
					best = c;
				}
			}
		}
		if (best) return best;
		// Fallback: nearest block starting at or before the line
		for (var j = 0; j < all.length; j++) {
			var d = all[j];
			if (d.start <= line && (!best || d.start > best.start)) best = d;
		}
		return best;
	}

	// The widget must sit AFTER the anchor but as a sibling that does not
	// break lists/tables: walk up until the parent allows a div child.
	// data-marker-wrapper marks a block another feature has wrapped (mermaid
	// wraps its fence so it can swap in a diagram) — climb out of those too, or
	// the widget ends up buried among that feature's own controls.
	function insertionPoint(node) {
		var breakers = {UL: 1, OL: 1, TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, PRE: 1};
		var current = node;
		while (current.parentElement && current.parentElement !== content() &&
			(breakers[current.parentElement.tagName] ||
				current.parentElement.hasAttribute('data-marker-wrapper'))) {
			current = current.parentElement;
		}
		return current;
	}

	// Where a thread's widget goes. A row of a table or an item of a list can
	// be a long way from the end of the block it sits in, and a comment shown
	// down there loses its subject; a table row and a list item can each hold
	// the widget where the comment was actually made, the way GitHub puts a
	// review comment under the line it is about. Anything else keeps the old
	// answer: after the whole block, since a <pre> or another feature's wrapper
	// has nowhere to put it.
	function placementFor(node) {
		var element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
		var root = content();
		if (element && root) {
			var row = element.closest('tr');
			if (row && root.contains(row) && !row.closest('[data-marker-wrapper]')) {
				return {kind: 'row', node: row};
			}

			var item = element.closest('li');
			if (item && root.contains(item) && !item.closest('[data-marker-wrapper]')) {
				return {kind: 'item', node: item};
			}
		}

		return {kind: 'block', node: insertionPoint(node)};
	}

	// Insert after the anchor, but behind any widgets already sitting there —
	// threads arrive sorted by line, so this keeps same-block comments in
	// ascending line order instead of each new one cutting in at the top
	function insertAt(placement, element) {
		if (placement.kind === 'item') {
			placement.node.append(element);
			return;
		}

		var target = placement.node;
		if (placement.kind === 'row') {
			// A widget is not a cell: it rides in a row of its own, spanning
			// the columns of the row it belongs to
			var cell = el('td', 'marker-thread-cell');
			cell.setAttribute('colspan', String(target.children.length || 1));
			cell.append(element);
			var host = el('tr', 'marker-thread-row');
			host.setAttribute('data-marker-ui', '');
			host.append(cell);
			element = host;
		}

		while (target.nextElementSibling &&
			target.nextElementSibling.hasAttribute('data-marker-ui')) {
			target = target.nextElementSibling;
		}

		target.insertAdjacentElement('afterend', element);
	}

	/* ---------- quote highlighting ---------- */

	function textEntries() {
		var root = content();
		if (!root) return {entries: [], raw: ''};
		var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: function (node) {
				var parent = node.parentElement;
				if (!parent) return NodeFilter.FILTER_REJECT;
				if (parent.closest('[data-marker-ui]')) return NodeFilter.FILTER_REJECT;
				return NodeFilter.FILTER_ACCEPT;
			}
		});
		var entries = [];
		var raw = '';
		var node;
		while ((node = walker.nextNode())) {
			entries.push({node: node, start: raw.length});
			raw += node.nodeValue;
		}
		return {entries: entries, raw: raw};
	}

	// Collapse whitespace runs to single spaces, keeping a map from each
	// normalized index back to the raw index it came from
	function normalize(raw) {
		var text = '';
		var map = [];
		var inWs = false;
		for (var i = 0; i < raw.length; i++) {
			if (/\s/.test(raw[i])) {
				if (!inWs && text.length > 0) {
					text += ' ';
					map.push(i);
				}
				inWs = true;
			} else {
				text += raw[i];
				map.push(i);
				inWs = false;
			}
		}
		return {text: text, map: map};
	}

	// Elements whose content model has no room for a <mark> beside their text.
	// Markdown-it puts each cell of a table on its own line, so a <tr> holds
	// newline text nodes between its <td>s — part of the corpus, and what makes
	// a quote spanning several cells match at all, since normalizing turns them
	// into the spaces the browser hands over when a row is selected. Wrapping
	// them, though, drops a <mark> straight into the <tr>, where the browser
	// renders it as a cell of its own and the row gains columns.
	var UNWRAPPABLE = {TABLE: 1, THEAD: 1, TBODY: 1, TFOOT: 1, TR: 1, COLGROUP: 1};

	function wrapRawRange(entries, rawStart, rawEnd, className, threadId) {
		var marks = [];
		for (var i = 0; i < entries.length; i++) {
			var entry = entries[i];
			var parent = entry.node.parentElement;
			if (parent && UNWRAPPABLE[parent.tagName]) continue;
			var len = entry.node.nodeValue.length;
			var nodeEnd = entry.start + len;
			if (nodeEnd <= rawStart || entry.start >= rawEnd) continue;

			var from = Math.max(0, rawStart - entry.start);
			var to = Math.min(len, rawEnd - entry.start);
			var target = entry.node;
			if (from > 0) target = target.splitText(from);
			if (to - from < target.nodeValue.length) target.splitText(to - from);

			var mark = el('mark', className);
			if (threadId) mark.setAttribute('data-thread-id', threadId);
			target.parentNode.insertBefore(mark, target);
			mark.appendChild(target);
			marks.push(mark);
		}
		return marks;
	}

	// Raw-text region [start, end) covered by the blocks whose source-line
	// range intersects the thread's line range. Short quotes ("事象" etc.)
	// can occur many times in a document; the line range pins down which
	// occurrence the comment is about.
	function lineRangeRegion(entries, lineStart, lineEnd) {
		var blocks = candidates().filter(function (candidate) {
			return candidate.start <= lineEnd && candidate.end >= lineStart;
		});
		if (blocks.length === 0) return null;

		var start = -1;
		var end = -1;
		entries.forEach(function (entry) {
			var inside = blocks.some(function (block) {
				return block.node.contains(entry.node);
			});
			if (!inside) return;
			if (start === -1 || entry.start < start) start = entry.start;
			var entryEnd = entry.start + entry.node.nodeValue.length;
			if (entryEnd > end) end = entryEnd;
		});

		return start === -1 ? null : {start: start, end: end};
	}

	// All occurrences of `needle` in the collected raw text, as raw ranges
	function occurrencesOf(norm, needle) {
		var occurrences = [];
		var searchFrom = 0;
		var index;
		while ((index = norm.text.indexOf(needle, searchFrom)) !== -1) {
			occurrences.push({
				rawStart: norm.map[index],
				rawEnd: norm.map[index + needle.length - 1] + 1
			});
			searchFrom = index + 1;
		}
		return occurrences;
	}

	// Where a quote sits in the rendered text: for a thread, and equally for
	// the selection a form or editor was opened on, which carries the same
	// three facts — lines, quote, occurrence
	function locateQuote(item) {
		if (!item.quote) return null;
		var collected = textEntries();
		var norm = normalize(collected.raw);
		var needle = normalize(item.quote).text.trim();
		if (!needle) return null;

		var occurrences = occurrencesOf(norm, needle);
		if (occurrences.length === 0) return null;

		// Prefer, in order: the selected occurrence inside the commented line
		// range, then the first one after that region starts, then the first
		// at all. quoteIndex says which occurrence in the region was selected,
		// so two identical words in one block do not collapse onto the first.
		var region = lineRangeRegion(collected.entries, item.lineStart, item.lineEnd);
		var chosen = null;
		if (region) {
			var inside = occurrences.filter(function (occurrence) {
				return occurrence.rawStart >= region.start && occurrence.rawEnd <= region.end;
			});
			if (inside.length > 0) {
				var wanted = Number.isInteger(item.quoteIndex) ? item.quoteIndex : 0;
				chosen = inside[Math.min(wanted, inside.length - 1)];
			}
			if (!chosen) {
				for (var p = 0; p < occurrences.length; p++) {
					if (occurrences[p].rawStart >= region.start) {
						chosen = occurrences[p];
						break;
					}
				}
			}
		}
		chosen = chosen || occurrences[0];
		return {entries: collected.entries, start: chosen.rawStart, end: chosen.rawEnd};
	}

	function highlightQuote(thread) {
		var found = locateQuote(thread);
		if (!found) return;

		var marks = wrapRawRange(found.entries, found.start, found.end,
			'marker-quote' + (thread.resolved ? ' resolved' : ''), thread.id);

		marks.forEach(function (mark) {
			mark.addEventListener('click', function (event) {
				// A highlight can sit inside an auto-linkified URL, and then the
				// click belongs to the thread, not to the anchor around it
				if (event.target.closest('a')) {
					event.preventDefault();
				}

				var selector = '.marker-thread[data-thread-id="' + thread.id + '"]';
				var widget = document.querySelector(selector);

				// In 'mark' mode, clicking a highlight toggles its thread
				if (state.viewMode === 'mark') {
					if (widget) {
						delete state.revealed[thread.id];
						render();
						return;
					}

					state.revealed[thread.id] = true;
					render();
					widget = document.querySelector(selector);
				}

				if (!widget) return;
				state.collapsed[thread.id] = false;
				widget.classList.remove('collapsed');
				var chevron = widget.querySelector('.marker-chevron');
				if (chevron) chevron.textContent = '▾';
				if (typeof widget.scrollIntoView === 'function') {
					widget.scrollIntoView({behavior: 'smooth', block: 'center'});
				}
				widget.classList.add('flash');
				setTimeout(function () {
					widget.classList.remove('flash');
				}, 1200);
			});
		});
	}

	function unwrapQuotes() {
		var marks = document.querySelectorAll('mark.marker-quote');
		for (var i = 0; i < marks.length; i++) {
			var mark = marks[i];
			var parent = mark.parentNode;
			while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
			parent.removeChild(mark);
			parent.normalize();
		}
	}

	// The selection a form or editor was opened on is marked from a live
	// Range, and a hot reload replaces the content that Range pointed into.
	// What the Range said is kept with the draft — lines, quote, occurrence —
	// which is enough to find the same text again, exactly as a thread's
	// highlight is found. One selection is marked at a time: the editor's if
	// it is open, else the open comment form's.
	function restorePendingMarks() {
		if (document.querySelector('mark.marker-pending')) return;

		var source = null;
		if (state.editor) {
			source = {
				lineStart: state.editor.selStart,
				lineEnd: state.editor.selEnd,
				quote: state.editor.quote,
				quoteIndex: state.editor.quoteIndex
			};
		} else {
			var open = Object.keys(state.openForms).filter(function (key) {
				return key.indexOf('new:') === 0 && state.drafts[key];
			});
			if (open.length > 0) source = state.drafts[open[0]];
		}

		if (!source) return;
		var found = locateQuote(source);
		if (found) wrapRawRange(found.entries, found.start, found.end, 'marker-pending', null);
	}

	// Which of our textareas the reader is in, and their caret, kept in state
	// so a rebuild can hand both back: focused again without scrolling to it —
	// it is where they were typing, not where they were reading, and every
	// comments push used to drag the page back to it. The blur a removed
	// textarea gets is not the reader moving on, but it arrives while the
	// element is still in the tree, so the question is asked a tick later,
	// when a removed element has been removed.
	function trackFocus(textarea, key) {
		textarea.setAttribute('data-marker-focus', key);

		function remember() {
			state.caret[key] = [textarea.selectionStart, textarea.selectionEnd];
		}

		textarea.addEventListener('focus', function () {
			state.focused = key;
			remember();
		});
		textarea.addEventListener('blur', function () {
			setTimeout(function () {
				if (state.focused !== key || !textarea.isConnected) return;
				if (document.activeElement !== textarea) state.focused = null;
			}, 0);
		});
		['input', 'keyup', 'mouseup'].forEach(function (type) {
			textarea.addEventListener(type, remember);
		});
	}

	function restoreFocus() {
		if (!state.focused) return;
		var textarea = document.querySelector(
			'textarea[data-marker-focus="' + state.focused + '"]');
		if (!textarea || document.activeElement === textarea) return;

		// Read before focusing: the focus listener records the caret of the
		// textarea being focused, which for a fresh one is the end of its text
		var caret = state.caret[state.focused];
		textarea.focus({preventScroll: true});
		if (caret && typeof textarea.setSelectionRange === 'function') {
			textarea.setSelectionRange(caret[0], caret[1]);
		}
	}

	// A widget and, if it rode in a row of its own, that row: an emptied host
	// row still holds a column-spanning cell the table is laid out around
	function removeWidget(node) {
		var host = node.parentElement && node.parentElement.closest('tr.marker-thread-row');
		node.remove();
		if (host && !host.querySelector('.marker-editor, .marker-thread, .marker-form')) {
			host.remove();
		}
	}

	// The selection a form or editor was opened on. Focus moving into the
	// textarea takes the browser's own highlight with it, and the reader is
	// left writing about text they can no longer see marked, so the range is
	// wrapped in a mark of its own and kept until they move on. Not marked as
	// UI: it wraps real content, and hiding that text from the quote corpus
	// would shift quoteIndex counting for every thread after it. Adding a
	// mark changes no characters, so the corpus is unaffected either way.
	function clearPending() {
		var marks = document.querySelectorAll('mark.marker-pending');
		for (var i = 0; i < marks.length; i++) {
			var mark = marks[i];
			var parent = mark.parentNode;
			while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
			parent.removeChild(mark);
			parent.normalize();
		}
	}

	function highlightPending(range) {
		if (!range || range.collapsed) return;

		var root = content();
		if (!root || !root.contains(range.commonAncestorContainer)) return;

		// Collect first, then wrap: wrapping splits text nodes as it goes
		var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: function (node) {
				if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
				var parent = node.parentElement;
				if (!parent) return NodeFilter.FILTER_REJECT;
				if (parent.closest('[data-marker-ui]')) return NodeFilter.FILTER_REJECT;
				// A mark is not a cell. Dropped straight into a row it becomes
				// an anonymous one, and the table lays its columns out around
				// a column that is not there — which is what a selection
				// crossing two rows does, the nodes between cells being the
				// whitespace of the markup and having nothing to show anyway.
				if (UNWRAPPABLE[parent.tagName]) return NodeFilter.FILTER_REJECT;
				return NodeFilter.FILTER_ACCEPT;
			}
		});

		var nodes = [];
		var node;
		while ((node = walker.nextNode())) nodes.push(node);

		nodes.forEach(function (text) {
			var from = text === range.startContainer ? range.startOffset : 0;
			var to = text === range.endContainer ? range.endOffset : text.nodeValue.length;
			if (to <= from) return;

			var target = text;
			if (from > 0) target = target.splitText(from);
			if (to - from < target.nodeValue.length) target.splitText(to - from);

			var mark = el('mark', 'marker-pending');
			target.parentNode.insertBefore(mark, target);
			mark.appendChild(target);
		});
	}

	/* ---------- forms & widgets ---------- */

	function textareaForm(draftKey, placeholder, onSubmit, onCancel) {
		var form = el('div', 'marker-form');
		form.setAttribute('data-marker-ui', '');

		var draft = state.drafts[draftKey] || {};

		if (draft.quote) {
			var preview = el('div', 'marker-quote-preview', draft.quote.length > 160 ?
				draft.quote.slice(0, 160) + '…' : draft.quote);
			form.appendChild(preview);
		}

		var textarea = el('textarea', 'marker-textarea');
		textarea.placeholder = placeholder;
		textarea.setAttribute('data-draft-key', draftKey);
		if (draft.text) textarea.value = draft.text;
		trackFocus(textarea, draftKey);
		textarea.addEventListener('input', function () {
			state.drafts[draftKey] = state.drafts[draftKey] || {};
			state.drafts[draftKey].text = textarea.value;
		});

		var actions = el('div', 'marker-form-actions');
		var save = el('button', 'marker-btn marker-btn-primary', 'Comment');
		var cancel = el('button', 'marker-btn', 'Cancel');
		var hint = el('span', 'marker-form-hint', 'Shift+Enter to post');

		function submit() {
			if (save.disabled) return;
			var body = textarea.value.trim();
			if (!body) return;
			var author = getAuthor();
			if (!author) return;
			save.disabled = true;
			onSubmit(body, author).then(function () {
				delete state.drafts[draftKey];
				delete state.openForms[draftKey];
				// The comment now carries its own highlight; the selection's
				// would sit on top of it. An editor still open gets its mark
				// back from the render that follows.
				clearPending();
				refresh();
			}).catch(function (error) {
				save.disabled = false;
				window.alert('Failed to post comment: ' + error.message);
			});
		}

		save.addEventListener('click', submit);

		// Shift+Enter posts, so the mouse never has to leave the keyboard.
		// Plain Enter keeps inserting a newline. isComposing guards Japanese
		// and other IME input, where Enter commits the conversion candidate.
		textarea.addEventListener('keydown', function (event) {
			if (event.key !== 'Enter' || !event.shiftKey) return;
			if (event.isComposing || event.keyCode === 229) return;
			event.preventDefault();
			submit();
		});

		cancel.addEventListener('click', function () {
			delete state.drafts[draftKey];
			delete state.openForms[draftKey];
			clearPending();
			if (onCancel) onCancel();
			removeWidget(form);
			// An editor still open keeps its mark
			restorePendingMarks();
		});

		actions.appendChild(save);
		actions.appendChild(cancel);
		actions.appendChild(hint);
		form.appendChild(textarea);
		form.appendChild(actions);
		return form;
	}

	/* ---------- snapshot diff (side-by-side, GitHub style) ---------- */

	// The word-level diff itself lives in diff-core.js, shared with the
	// side-by-side view of a ```diff block; here it is only turned into cells.
	// Defaulted rather than assumed: if that asset ever fails to load, the
	// cost should be one missing diff, not the whole comment UI.
	var diffCore = window.markerDiff || {};

	function diffCell(spec) {
		var cell = el('td', 'marker-diff-cell ' + spec.type);
		if (spec.segs) {
			spec.segs.forEach(function (segment) {
				if (segment.changed) {
					cell.appendChild(el('span', 'chg', segment.text));
				} else {
					cell.appendChild(document.createTextNode(segment.text));
				}
			});
		} else if (spec.text !== undefined) {
			cell.textContent = spec.text;
		}
		return cell;
	}

	function diffNode(snapshotText, currentText) {
		if (!diffCore.lcsOps) return null;

		var wrap = el('div', 'marker-diff');
		var title = el('div', 'marker-diff-title',
			'The commented lines have changed since this comment was written:');
		wrap.appendChild(title);

		var head = el('div', 'marker-diff-head');
		head.appendChild(el('span', '', 'when commented'));
		head.appendChild(el('span', '', 'now'));
		wrap.appendChild(head);

		var table = el('table', 'marker-diff-table');
		var rows = [];
		var dels = [];
		var adds = [];

		function flushPairs() {
			var count = Math.max(dels.length, adds.length);
			for (var k = 0; k < count; k++) {
				var oldLine = dels[k];
				var newLine = adds[k];
				if (oldLine !== undefined && newLine !== undefined) {
					var segments = diffCore.charSegments(oldLine, newLine);
					rows.push([{type: 'del', segs: segments.left}, {type: 'add', segs: segments.right}]);
				} else if (oldLine !== undefined) {
					rows.push([{type: 'del', text: oldLine}, {type: 'empty'}]);
				} else {
					rows.push([{type: 'empty'}, {type: 'add', text: newLine}]);
				}
			}
			dels = [];
			adds = [];
		}

		diffCore.lcsOps(snapshotText.split('\n'), currentText.split('\n')).forEach(function (entry) {
			if (entry.op === '-') {
				dels.push(entry.item);
			} else if (entry.op === '+') {
				adds.push(entry.item);
			} else {
				flushPairs();
				rows.push([{type: 'ctx', text: entry.item}, {type: 'ctx', text: entry.item}]);
			}
		});
		flushPairs();

		rows.forEach(function (row) {
			var tr = el('tr', 'marker-diff-row');
			tr.appendChild(diffCell(row[0]));
			tr.appendChild(diffCell(row[1]));
			table.appendChild(tr);
		});

		wrap.appendChild(table);
		return wrap;
	}

	function commentNode(comment) {
		var wrap = el('div', 'marker-comment');
		var head = el('div', 'marker-comment-head');
		head.appendChild(el('span', 'marker-author', comment.author));
		head.appendChild(el('span', 'marker-time', fmtTime(comment.createdAt)));

		var remove = el('a', 'marker-link marker-delete', 'delete');
		remove.href = 'javascript:void(0)';
		remove.addEventListener('click', function () {
			if (!window.confirm('Delete this comment' + (comment.parentId ? '' : ' and its replies') + '?')) return;
			api('DELETE', cfg.apiBase + '/comments/' + comment.id).then(refresh);
		});
		head.appendChild(remove);

		wrap.appendChild(head);
		wrap.appendChild(el('div', 'marker-body', comment.body));
		return wrap;
	}

	function threadWidget(thread, startCollapsed) {
		var widget = el('div', 'marker-thread' + (thread.resolved ? ' resolved' : ''));
		widget.setAttribute('data-marker-ui', '');
		widget.setAttribute('data-thread-id', thread.id);

		// Collapsed unless the user toggled it. Resolved threads start that way,
		// and so does one sitting inside a table or a list, where an open
		// thread would push the rows around it apart.
		var isCollapsed = Object.prototype.hasOwnProperty.call(state.collapsed, thread.id) ?
			state.collapsed[thread.id] : (thread.resolved || Boolean(startCollapsed));

		var head = el('div', 'marker-thread-head');
		head.title = 'Click to collapse / expand';
		var chevron = el('span', 'marker-chevron', isCollapsed ? '▸' : '▾');
		head.appendChild(chevron);
		var lines = thread.lineStart === thread.lineEnd ?
			'L' + thread.lineStart : 'L' + thread.lineStart + '-' + thread.lineEnd;
		head.appendChild(el('span', 'marker-lines', lines));

		if (thread.quote) {
			head.appendChild(el('span', 'marker-head-quote', thread.quote.length > 60 ?
				thread.quote.slice(0, 60) + '…' : thread.quote));
		}

		if (thread.changed) {
			head.appendChild(el('span', 'marker-changed-badge', '⚠ edited'));
		}

		head.appendChild(el('span', 'marker-count',
			(1 + thread.replies.length) + (thread.replies.length === 0 ? ' comment' : ' comments')));

		var resolveBtn = el('button', 'marker-btn marker-btn-small',
			thread.resolved ? '↩ Unresolve' : '✔︎ Resolve');
		resolveBtn.addEventListener('click', function (event) {
			event.stopPropagation();
			api('PATCH', cfg.apiBase + '/comments/' + thread.id, {resolved: !thread.resolved})
				.then(refresh)
				.catch(function (error) {
					window.alert(error.message);
				});
		});
		head.appendChild(resolveBtn);

		// Deleting is also offered on each comment inside the body, but that
		// is out of reach while the thread is collapsed — which is the state a
		// thread worth deleting is usually in. This one takes the whole thread.
		var replyCount = thread.replies.length;
		var deleteBtn = el('button', 'marker-btn marker-btn-small marker-thread-delete', '🗑');
		deleteBtn.title = replyCount === 0 ?
			'Delete this comment' :
			'Delete this comment and its ' + replyCount +
				(replyCount === 1 ? ' reply' : ' replies');
		deleteBtn.addEventListener('click', function (event) {
			// Or the head underneath would collapse the thread as well
			event.stopPropagation();
			if (!window.confirm(deleteBtn.title + '?')) return;
			api('DELETE', cfg.apiBase + '/comments/' + thread.id)
				.then(refresh)
				.catch(function (error) {
					window.alert(error.message);
				});
		});
		head.appendChild(deleteBtn);
		widget.appendChild(head);

		var bodyWrap = el('div', 'marker-thread-body');

		if (thread.changed && thread.snapshot && thread.currentText !== null) {
			var diff = diffNode(thread.snapshot.text, thread.currentText);
			if (diff) bodyWrap.appendChild(diff);
		}

		bodyWrap.appendChild(commentNode(thread));
		thread.replies.forEach(function (reply) {
			bodyWrap.appendChild(commentNode(reply));
		});

		var draftKey = 'reply:' + thread.id;
		var replyLink = el('a', 'marker-link', 'Reply…');
		replyLink.href = 'javascript:void(0)';

		function openReply() {
			state.openForms[draftKey] = true;
			replyLink.style.display = 'none';
			bodyWrap.appendChild(textareaForm(draftKey, 'Reply…', function (body, author) {
				return api('POST', API, {parentId: thread.id, body: body, author: author});
			}, function () {
				replyLink.style.display = '';
			}));
		}

		replyLink.addEventListener('click', function () {
			openReply();
			state.focused = draftKey;
			restoreFocus();
		});
		bodyWrap.appendChild(replyLink);
		widget.appendChild(bodyWrap);

		if (isCollapsed) {
			widget.classList.add('collapsed');
		}

		head.addEventListener('click', function () {
			var collapsed = widget.classList.toggle('collapsed');
			state.collapsed[thread.id] = collapsed;
			chevron.textContent = collapsed ? '▸' : '▾';
		});

		if (state.openForms[draftKey]) openReply();
		return widget;
	}

	/* ---------- selection -> comment / edit buttons ---------- */

	var selectionBar = null;
	var selectionButton = null;
	var editButton = null;
	var editLines = null;
	var pendingSelection = null;

	// Which occurrence of the quote inside the anchored block the reader
	// selected, counted with the same enumeration highlightQuote uses at read
	// time so the two always agree. 0 when it cannot be determined.
	function selectedOccurrence(range, quote, lineStart, lineEnd) {
		var collected = textEntries();
		var norm = normalize(collected.raw);
		var needle = normalize(quote).text.trim();
		if (!needle) return 0;

		// Raw offset where the selection starts
		var selStart = -1;
		for (var i = 0; i < collected.entries.length; i++) {
			if (collected.entries[i].node === range.startContainer) {
				selStart = collected.entries[i].start + range.startOffset;
				break;
			}
		}
		if (selStart === -1) return 0;

		var region = lineRangeRegion(collected.entries, lineStart, lineEnd);
		if (!region) return 0;

		var count = 0;
		occurrencesOf(norm, needle).forEach(function (occurrence) {
			if (occurrence.rawStart >= region.start && occurrence.rawEnd <= region.end &&
				occurrence.rawStart < selStart) {
				count++;
			}
		});
		return count;
	}

	// One positioned bar holding both actions, so the pair travels together
	// and neither needs coordinates of its own. Marked as UI, or blockOf would
	// treat a selection made inside it as commentable text.
	function ensureSelectionButton() {
		if (selectionBar) return selectionBar;

		selectionBar = el('div', 'marker-select-bar');
		selectionBar.setAttribute('data-marker-ui', '');

		// Mousedown, not click: mousedown would otherwise collapse the
		// selection before a click could fire
		function action(className, icon, label, run, badge) {
			var button = el('button', className);
			var lines = null;
			// The icon is a flex item of its own: an emoji's fallback font has
			// a taller ascent than the label's, and sharing an inline box with
			// it pushes the label's letters down inside the button, away from
			// the badge centred beside them
			button.appendChild(el('span', 'marker-select-icon', icon));
			button.appendChild(el('span', 'marker-select-label', label));
			if (badge) {
				lines = el('span', 'marker-select-lines');
				button.appendChild(lines);
			}

			button.addEventListener('mousedown', function (event) {
				event.preventDefault();
				event.stopPropagation();

				// Marked before the native selection goes, and from the live
				// range rather than the stored line numbers, so the highlight
				// is exactly what was selected
				var selection = window.getSelection();
				clearPending();
				if (selection && selection.rangeCount > 0) {
					highlightPending(selection.getRangeAt(0));
				}

				if (pendingSelection) run(pendingSelection);
				hideSelectionButton();
				if (selection) selection.removeAllRanges();
			});
			selectionBar.appendChild(button);
			return {button: button, lines: lines};
		}

		// Only the editor wears a line number: a comment lands on what was
		// selected, which the reader is looking at, while the editor opens a
		// window they have not seen yet
		var comment = action('marker-select-btn', '💬', 'Comment', openSelectionForm, false);
		selectionButton = comment.button;

		var edit = action('marker-select-btn marker-select-edit', '✏️', 'Edit', openEditor, true);
		editButton = edit.button;
		editLines = edit.lines;

		document.body.appendChild(selectionBar);
		return selectionBar;
	}

	function hideSelectionButton() {
		if (selectionBar) selectionBar.style.display = 'none';
	}

	function maybeShowSelectionButton() {
		var selection = window.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
			hideSelectionButton();
			return;
		}

		var range = selection.getRangeAt(0);
		var startBlock = blockOf(range.startContainer);
		var endBlock = blockOf(range.endContainer);
		if (!startBlock || !endBlock) {
			hideSelectionButton();
			return;
		}

		var quote = String(selection).trim().slice(0, QUOTE_MAX);
		if (!quote) {
			hideSelectionButton();
			return;
		}

		var lineStart = lineRangeOf(startBlock).start;
		var lineEnd = lineRangeOf(endBlock).end;

		pendingSelection = {
			lineStart: lineStart,
			lineEnd: lineEnd,
			quote: quote,
			quoteIndex: selectedOccurrence(range, quote, lineStart, lineEnd),
			endBlock: endBlock
		};

		var rect = typeof range.getBoundingClientRect === 'function' ?
			range.getBoundingClientRect() :
			endBlock.getBoundingClientRect();
		var bar = ensureSelectionButton();
		// A fresh selection supersedes whatever the last one marked
		if (!state.editor && !document.querySelector('.marker-form')) clearPending();
		// The lines selected, not the wider window the editor opens around
		// them: it is the selection the reader is pointing at
		editLines.textContent = lineStart === lineEnd ?
			'L' + lineStart : 'L' + lineStart + '-' + lineEnd;
		bar.style.display = 'flex';
		bar.style.top = (window.scrollY + rect.bottom + 6) + 'px';
		bar.style.left = (window.scrollX + Math.max(rect.left, 8)) + 'px';
	}

	function openSelectionForm(sel) {
		var draftKey = 'new:' + sel.lineStart + ':' + sel.lineEnd;
		state.drafts[draftKey] = state.drafts[draftKey] || {};
		state.drafts[draftKey].lineStart = sel.lineStart;
		state.drafts[draftKey].lineEnd = sel.lineEnd;
		state.drafts[draftKey].quote = sel.quote;
		state.drafts[draftKey].quoteIndex = sel.quoteIndex;
		state.openForms[draftKey] = true;

		state.focused = draftKey;
		if (!document.querySelector('[data-draft-key="' + draftKey + '"]')) {
			insertNewCommentForm(draftKey, sel.endBlock);
		}

		restoreFocus();
	}

	function insertNewCommentForm(draftKey, endBlock) {
		var draft = state.drafts[draftKey];
		if (!draft) return;

		// The block the selection ended in, if it is still the one on the
		// page: a hot reload between selecting and clicking replaces it, and a
		// form inserted after a detached node appears nowhere. Re-found by its
		// line, it lands where the original placement did — at the end block.
		var root = content();
		var anchor = endBlock && root && root.contains(endBlock) ?
			endBlock : (anchorFor(draft.lineEnd) || {}).node;
		if (!anchor) return;

		var form = textareaForm(draftKey,
			'Comment on L' + draft.lineStart +
			(draft.lineEnd > draft.lineStart ? '-' + draft.lineEnd : '') + '…',
			function (body, author) {
				return api('POST', API, {
					lineStart: draft.lineStart,
					lineEnd: draft.lineEnd,
					quote: draft.quote,
					quoteIndex: draft.quoteIndex,
					body: body,
					author: author
				});
			});
		// Where the widget for this comment will end up, so writing it happens
		// in the same place as reading it
		insertAt(placementFor(anchor), form);
		pinRowWidgets();
	}

	/* ---------- editing the source ---------- */

	// Lives here rather than in an asset of its own because it hangs off the
	// same selection and reuses the same anchoring and placement machinery
	// (blockOf, placementFor, insertAt), all private to this closure.

	var CONTEXT_LINES = 3;
	// One editor at a time: it belongs to one selection, and two panels
	// editing overlapping ranges could only disagree
	var editHistory = [];
	var editCursor = 0;

	function editorRange(lineStart, lineEnd) {
		return {
			lineStart: Math.max(1, lineStart - CONTEXT_LINES),
			lineEnd: lineEnd + CONTEXT_LINES
		};
	}

	function fileContent() {
		return api('GET', cfg.apiBase + '/files/' + cfg.fileId + '/content');
	}

	// The lines a range holds, clamped to the file. The trailing '' of a file
	// ending in a newline counts as a line here exactly as it does on the
	// server, or the two would disagree about where the range ends.
	function sliceLines(content, lineStart, lineEnd) {
		var lines = content.split('\n');
		var end = Math.min(lineEnd, lines.length);
		return {
			text: lines.slice(lineStart - 1, end).join('\n'),
			lineStart: lineStart,
			lineEnd: end
		};
	}

	function openEditor(sel) {
		var range = editorRange(sel.lineStart, sel.lineEnd);
		fileContent().then(function (data) {
			var slice = sliceLines(data.content, range.lineStart, range.lineEnd);
			state.editor = {
				lineStart: slice.lineStart,
				lineEnd: slice.lineEnd,
				base: slice.text,
				text: slice.text,
				anchorLine: sel.lineStart,
				// The lines the reader actually selected, marked in the gutter
				// so the context around them is obviously context
				selStart: sel.lineStart,
				selEnd: sel.lineEnd,
				// The text itself, marked inside the editor while it is still
				// there to mark
				quote: sel.quote,
				quoteIndex: sel.quoteIndex,
				disk: null
			};
			state.focused = 'editor';
			render();
		}).catch(function (error) {
			window.alert('Could not read the file: ' + error.message);
		});
	}

	// A widget riding in a table row needs a width given to it. A cell in an
	// auto-layout table asks for its content's max-content width, and
	// max-content does not wrap: a thread showing its snapshot diff of a
	// table row, or an editor holding source lines, presents the widest
	// source line as the width it wants, the columns are redistributed around
	// it and the table grows a sideways scrollbar it did not have. Prose wraps
	// at word boundaries and costs a cell nothing, which is why a bare thread
	// or comment form never showed this — but the diff inside one does. A
	// definite width asks the table for nothing it does not already have, and
	// `width: 100%` on the diff table inside has something to resolve against.
	// The measurement is taken with the table's widgets out of the layout,
	// because in it the table is already the width they made it and would only
	// confirm itself, and it is the cell that is measured, not the table: the
	// collapsed border around a table sits inside its client width, and a
	// widget given all of it pushes the columns out by that border and leaves
	// the table a pixel to scroll. The table stands in when the cell has no
	// width to report, which is jsdom.
	function pinRowWidgets() {
		var root = content();
		if (!root) return;

		[].forEach.call(root.querySelectorAll('table'), function (table) {
			var widgets = [].filter.call(
				table.querySelectorAll('tr.marker-thread-row > td > *'),
				function (widget) {
					return widget.closest('table') === table;
				});
			if (widgets.length === 0) return;

			widgets.forEach(function (widget) {
				widget.style.display = 'none';
			});
			var widths = widgets.map(function (widget) {
				var cell = widget.parentElement.clientWidth;
				if (!(cell > 0)) return table.clientWidth;
				// The cell spans the grid, which for a table that scrolls
				// sideways is wider than what shows. What shows is the table's
				// client width less the border the cell sits inside — the same
				// border the grid exceeds the cell by.
				var chrome = Math.max(0, table.scrollWidth - cell);
				return Math.min(cell, table.clientWidth - chrome);
			});
			widgets.forEach(function (widget, i) {
				widget.style.display = '';
				if (widths[i] > 0) widget.style.width = widths[i] + 'px';
			});
		});
	}

	// A narrower window means a narrower table, and a width in pixels does not
	// follow one on its own
	window.addEventListener('resize', pinRowWidgets);

	function dropEditorPanels() {
		var open = document.querySelectorAll('.marker-editor');
		for (var i = 0; i < open.length; i++) removeWidget(open[i]);
	}

	// The panel survives a plain re-render (see keptAcrossRender); when its
	// own content has to change — the disk pane arriving or leaving — it is
	// dropped first, and the render that follows builds it afresh
	function rebuildEditor() {
		dropEditorPanels();
		render();
	}

	function closeEditor() {
		clearPending();
		state.editor = null;
		dropEditorPanels();
		// A form still open keeps its mark
		restorePendingMarks();
		paintHistoryButtons();
	}

	// Undo and redo are file writes in reverse, located by their text like any
	// other, so they still land correctly after something else moved the lines.
	// Typing inside the textarea is the browser's own undo and stays untouched.
	function applyEdit(entry, options) {
		var body = {
			lineStart: entry.lineStart,
			lineEnd: entry.lineEnd,
			base: entry.before,
			text: entry.after
		};
		if (options && options.force) body.force = true;
		return api('PATCH', cfg.apiBase + '/files/' + cfg.fileId + '/content', body);
	}

	function remember(entry) {
		editHistory = editHistory.slice(0, editCursor);
		editHistory.push(entry);
		editCursor = editHistory.length;
		paintHistoryButtons();
	}

	function stepHistory(direction) {
		var index = direction < 0 ? editCursor - 1 : editCursor;
		var entry = editHistory[index];
		if (!entry) return;

		var undoing = direction < 0;
		var move = {
			lineStart: entry.lineStart,
			lineEnd: entry.lineEnd,
			before: undoing ? entry.after : entry.before,
			after: undoing ? entry.before : entry.after
		};

		applyEdit(move).then(function (written) {
			// The text that came back may occupy a different number of lines
			entry.lineStart = written.lineStart;
			entry.lineEnd = written.lineEnd;
			editCursor += direction;
			paintHistoryButtons();
		}).catch(function (error) {
			window.alert(error.message);
		});
	}

	function paintHistoryButtons() {
		var controls = document.querySelector('.page-controls');
		if (!controls) return;

		[['marker-undo', '↶', -1], ['marker-redo', '↷', 1]].forEach(function (spec) {
			var id = spec[0];
			var button = document.getElementById(id);
			var possible = spec[2] < 0 ? editCursor > 0 : editCursor < editHistory.length;

			// Nothing written yet, nothing to offer
			if (editHistory.length === 0) {
				if (button) button.remove();
				return;
			}

			if (!button) {
				button = el('button', 'page-btn marker-history-btn', spec[1]);
				button.id = id;
				button.addEventListener('click', function () {
					stepHistory(spec[2]);
				});
				controls.insertBefore(button, controls.firstChild);
			}

			button.title = (spec[2] < 0 ? 'Undo' : 'Redo') + ' the last edit applied to the file';
			button.disabled = !possible;
		});
	}

	// What the file holds now where the editor is pointing. Called when the
	// file changes underneath an open editor, which is the moment the reader
	// has to be told that their base is no longer the whole story.
	function refreshDiskView() {
		if (!state.editor) return;
		var editor = state.editor;

		fileContent().then(function (data) {
			if (state.editor !== editor) return;

			var lines = data.content.split('\n');
			var here = lines.slice(editor.lineStart - 1,
				Math.min(editor.lineEnd, lines.length)).join('\n');
			if (here === editor.base) {
				if (editor.disk) {
					editor.disk = null;
					rebuildEditor();
				}

				return;
			}

			// A refusal has already said its piece; keep that wording, since it
			// is the stronger statement of the same fact
			editor.disk = {text: here, refused: Boolean(editor.disk && editor.disk.refused)};
			rebuildEditor();
		}).catch(function () {});
	}

	function editorPanel() {
		var editor = state.editor;
		var panel = el('div', 'marker-editor');
		panel.setAttribute('data-marker-ui', '');

		var head = el('div', 'marker-editor-head');
		head.appendChild(el('span', '', '✏️'));
		head.appendChild(el('span', 'marker-lines', editor.lineStart === editor.lineEnd ?
			'L' + editor.lineStart : 'L' + editor.lineStart + '-' + editor.lineEnd));
		head.appendChild(el('span', 'marker-count', 'editing the file'));
		panel.appendChild(head);

		// Gutter and textarea in one row, the gutter scrolled to match.
		//
		// The lines wrap, so one source line can occupy several rows and a
		// gutter of evenly spaced numbers would drift away from its text. Each
		// number is therefore given the height its own line actually renders
		// to, measured by mirroring that line into a hidden div with the
		// textarea's content width and metrics — the one way to ask a textarea
		// how tall a line came out.
		var frame = el('div', 'marker-editor-frame');
		var gutter = el('div', 'marker-editor-gutter');
		var band = el('div', 'marker-editor-band');
		var quotes = el('div', 'marker-editor-quotes');
		var measure = el('div', 'marker-editor-measure');
		measure.setAttribute('aria-hidden', 'true');
		var textarea = el('textarea', 'marker-textarea marker-editor-textarea');
		textarea.value = editor.text;
		trackFocus(textarea, 'editor');
		textarea.rows = Math.min(20, editor.text.split('\n').length + 1);
		var rows = [];

		function alignGutter() {
			var style = window.getComputedStyle(textarea);
			var width = textarea.clientWidth -
				parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
			// No layout to measure against (jsdom, or not yet displayed):
			// leave the rows at their natural height
			if (!(width > 0)) return;

			measure.style.width = width + 'px';
			for (var i = 0; i < rows.length && i < measure.children.length; i++) {
				var height = measure.children[i].offsetHeight;
				if (height > 0) rows[i].style.height = height + 'px';
			}

			placeBand();
			placeQuote();
		}

		// The band behind the selected lines, which the same measurements
		// locate: a textarea cannot paint one line's background itself
		function placeBand() {
			var style = window.getComputedStyle(textarea);
			var top = parseFloat(style.paddingTop);
			var height = 0;

			for (var i = 0; i < measure.children.length; i++) {
				var line = editor.lineStart + i;
				var own = measure.children[i].offsetHeight;
				if (line < editor.selStart) {
					top += own;
				} else if (line <= editor.selEnd) {
					height += own;
				}
			}

			band.style.display = height > 0 ? 'block' : 'none';
			if (height <= 0) return;
			// Starts where the gutter ends, the numbers carrying their own half
			band.style.left = gutter.offsetWidth + 'px';
			band.style.top = (top - textarea.scrollTop) + 'px';
			band.style.height = height + 'px';
		}

		// Where each line of the editor's text begins, as an offset into it
		function lineOffsets(lines) {
			var starts = [];
			var offset = 0;
			lines.forEach(function (line) {
				starts.push(offset);
				offset += line.length + 1;
			});
			return starts;
		}

		// Where the quote sits in the source, which is not always a copy of it.
		// The text a selection reports is the rendered text: it has lost the
		// markup it came from, soft-wrapped source lines are joined with a
		// space, and blocks and table cells are separated by newlines and
		// tabs the file does not have. So a quote covering more than one line
		// is nowhere in it verbatim. What does survive is the words and their
		// order, and the run from the first of them to the last is the span
		// the reader dragged over — markup and cell separators included,
		// which is what their selection covered on the page too.
		function quoteSpan(text, regionStart, regionEnd) {
			var whole = [];
			for (var from = regionStart; ; ) {
				var hit = text.indexOf(editor.quote, from);
				if (hit < 0 || hit + editor.quote.length > regionEnd) break;
				whole.push(hit);
				from = hit + 1;
			}

			if (whole.length > 0) {
				// Clamped, as narrowRange clamps it: the rendered text a quote
				// was counted over can hold more copies than the source does
				var at = whole[Math.min(editor.quoteIndex || 0, whole.length - 1)];
				return {from: at, to: at + editor.quote.length};
			}

			var start = -1;
			var end = -1;
			var cursor = regionStart;
			editor.quote.split(/\s+/).forEach(function (word) {
				if (!word) return;
				var found = text.indexOf(word, cursor);
				// A word that markup has broken up is skipped rather than
				// searched for elsewhere: the run still spans it
				if (found < 0 || found + word.length > regionEnd) return;
				if (start === -1) start = found;
				end = found + word.length;
				cursor = end;
			});

			return start === -1 ? null : {from: start, to: end};
		}

		// What the marks track once the panel is open: the source text the
		// quote resolved to the first time round, matched verbatim from then
		// on. The loose matching above cannot tell an edit from a difference
		// it was built to tolerate — it still finds the words of a phrase the
		// reader has just rewritten, and the run between the first and the
		// last of them looks untouched. Matching the characters it resolved to
		// means editing them stops finding them, and the marks go.
		function quoteTarget(text, regionStart, regionEnd) {
			if (typeof editor.quoteSource !== 'string') {
				var span = quoteSpan(text, regionStart, regionEnd);
				editor.quoteSource = span ? text.slice(span.from, span.to) : '';
				editor.quoteAt = span ? span.from : -1;
			}

			if (!editor.quoteSource) return null;

			var best = -1;
			for (var from = regionStart; ; ) {
				var hit = text.indexOf(editor.quoteSource, from);
				if (hit < 0 || hit + editor.quoteSource.length > regionEnd) break;
				// The copy nearest where it was last seen, ties to the earlier
				if (best === -1 ||
					Math.abs(hit - editor.quoteAt) < Math.abs(best - editor.quoteAt)) {
					best = hit;
				}

				from = hit + 1;
			}

			if (best === -1) return null;
			editor.quoteAt = best;
			return {from: best, to: best + editor.quoteSource.length};
		}

		// The selected text itself, marked harder than the line it sits on.
		// A textarea cannot paint a range either, so the rectangles come from
		// the same mirror: a Range over the mirror's copy of a line lands
		// exactly where the textarea drew it, one rectangle per visual row.
		// Once the reader edits that text it stops being found and the marks
		// go — the point was to show what was selected, not to chase it.
		function placeQuote() {
			quotes.textContent = '';
			if (!editor.quote) return;

			var lines = textarea.value.split('\n');
			var starts = lineOffsets(lines);
			var first = editor.selStart - editor.lineStart;
			var last = editor.selEnd - editor.lineStart;
			if (first < 0 || last >= lines.length) return;

			// Only within the lines the reader selected: the same text can sit
			// in the context either side, and that is not what they picked
			var span = quoteTarget(textarea.value, starts[first],
				starts[last] + lines[last].length);
			if (!span) return;

			var at = span.from;
			var end = span.to;

			var style = window.getComputedStyle(textarea);
			var originX = gutter.offsetWidth + parseFloat(style.paddingLeft);
			var originY = parseFloat(style.paddingTop) - textarea.scrollTop;
			var mirror = measure.getBoundingClientRect();

			for (var i = 0; i < lines.length && i < measure.children.length; i++) {
				var lineFrom = Math.max(at, starts[i]);
				var lineTo = Math.min(end, starts[i] + lines[i].length);
				var node = measure.children[i].firstChild;
				if (lineTo <= lineFrom || !node) continue;

				var range = document.createRange();
				range.setStart(node, lineFrom - starts[i]);
				range.setEnd(node, lineTo - starts[i]);
				var rects = range.getClientRects();
				for (var r = 0; r < rects.length; r++) {
					var mark = el('div', 'marker-editor-quote');
					mark.style.left = (originX + rects[r].left - mirror.left) + 'px';
					mark.style.top = (originY + rects[r].top - mirror.top) + 'px';
					mark.style.width = rects[r].width + 'px';
					mark.style.height = rects[r].height + 'px';
					quotes.appendChild(mark);
				}
			}
		}

		function paintGutter() {
			var lines = textarea.value.split('\n');
			gutter.textContent = '';
			measure.textContent = '';
			rows = [];

			lines.forEach(function (text, n) {
				var line = editor.lineStart + n;
				var selected = line >= editor.selStart && line <= editor.selEnd;
				var row = el('div',
					'marker-editor-lineno' + (selected ? ' selected' : ''), String(line));
				gutter.appendChild(row);
				rows.push(row);
				// A zero-width space, or an empty line measures as no line
				measure.appendChild(el('div', '', text === '' ? '\u200b' : text));
			});

			alignGutter();
		}

		textarea.addEventListener('input', function () {
			editor.text = textarea.value;
			// Adding or removing a line changes what the gutter has to say,
			// and past the original range the numbers are only an estimate
			paintGutter();
		});
		textarea.addEventListener('scroll', function () {
			gutter.scrollTop = textarea.scrollTop;
			placeBand();
			placeQuote();
		});

		frame.appendChild(gutter);
		frame.appendChild(band);
		frame.appendChild(quotes);
		frame.appendChild(textarea);
		frame.appendChild(measure);
		panel.appendChild(frame);
		paintGutter();

		// A narrower panel rewraps the text, and the numbers have to follow.
		// The observer dies with the textarea, which a listener on window
		// would not.
		if (typeof ResizeObserver === 'function') {
			new ResizeObserver(alignGutter).observe(textarea);
		}

		var actions = el('div', 'marker-form-actions');
		var apply = el('button', 'marker-btn marker-btn-primary', 'Apply');
		var cancel = el('button', 'marker-btn', 'Cancel');
		actions.appendChild(apply);
		actions.appendChild(cancel);
		actions.appendChild(el('span', 'marker-form-hint', 'Shift+Enter to apply'));
		panel.appendChild(actions);

		function submit(options) {
			if (apply.disabled) return;
			apply.disabled = true;
			var entry = {
				lineStart: editor.lineStart,
				lineEnd: editor.lineEnd,
				before: editor.base,
				after: textarea.value
			};

			applyEdit(entry, options).then(function (written) {
				entry.lineStart = written.lineStart;
				entry.lineEnd = written.lineEnd;
				remember(entry);
				closeEditor();
			}).catch(function (error) {
				apply.disabled = false;
				// The lines moved out from under this edit: show what is there
				// now and let the reader pick a side rather than guessing
				if (error.current !== undefined) {
					editor.disk = {text: error.current, refused: true};
					rebuildEditor();
					return;
				}

				window.alert('Could not apply the edit: ' + error.message);
			});
		}

		apply.addEventListener('click', function () {
			submit();
		});
		cancel.addEventListener('click', closeEditor);

		textarea.addEventListener('keydown', function (event) {
			if (event.key !== 'Enter' || !event.shiftKey) return;
			if (event.isComposing || event.keyCode === 229) return;
			event.preventDefault();
			submit();
		});

		if (editor.disk) {
			panel.appendChild(diskPane(editor, submit));
		}

		return panel;
	}

	// The file as it stands, under the editor holding what it stood as. The
	// comparison is the thread snapshot's, so a reader who has seen one
	// already knows how to read this.
	function diskPane(editor, submit) {
		var pane = el('div', 'marker-editor-disk');
		pane.appendChild(el('div', 'marker-editor-disk-head', editor.disk.refused ?
			'These lines changed on disk, so the edit was not applied' :
			'These lines have changed on disk since this editor opened'));

		var diff = diffNode(editor.base, editor.disk.text);
		if (diff) {
			var title = diff.querySelector('.marker-diff-title');
			if (title) title.textContent = 'when this editor opened, against the file now:';
			var heads = diff.querySelectorAll('.marker-diff-head span');
			if (heads.length === 2) {
				heads[0].textContent = 'when opened';
				heads[1].textContent = 'on disk';
			}

			pane.appendChild(diff);
		} else {
			pane.appendChild(el('pre', 'marker-editor-disk-text', editor.disk.text));
		}

		var actions = el('div', 'marker-form-actions');
		var mine = el('button', 'marker-btn marker-editor-force', 'Apply my Edit');
		mine.title = 'Overwrite these lines with what is in the editor above';
		mine.addEventListener('click', function () {
			submit({force: true});
		});

		var theirs = el('button', 'marker-btn', "Apply other's Edit");
		theirs.title = 'Keep the version already in the file, discarding this edit';
		theirs.addEventListener('click', closeEditor);

		actions.appendChild(mine);
		actions.appendChild(theirs);
		pane.appendChild(actions);
		return pane;
	}

	/* ---------- view mode: all → unresolved → mark → plain ---------- */

	var VIEW_MODES = ['all', 'open', 'mark', 'off'];

	function setViewButtonContent(btn) {
		var icon = '💬';
		var label = 'all';
		if (state.viewMode === 'open') {
			label = 'unresolved';
		} else if (state.viewMode === 'mark') {
			icon = '🖍️';
			label = 'mark';
		} else if (state.viewMode === 'off') {
			icon = '・';
			label = 'plain';
		}

		btn.textContent = '';
		btn.appendChild(el('span', 'marker-view-icon', icon));
		btn.appendChild(el('span', 'marker-view-label', label));
	}

	function ensureViewButton() {
		var controls = document.querySelector('.page-controls');
		if (!controls || document.getElementById('marker-view-toggle')) return;
		var btn = el('button', 'page-btn marker-view-btn', '');
		btn.id = 'marker-view-toggle';
		btn.title = 'Comments: all → unresolved → mark (click a highlight to open) → plain';
		setViewButtonContent(btn);
		btn.addEventListener('click', function () {
			var next = VIEW_MODES[(VIEW_MODES.indexOf(state.viewMode) + 1) % VIEW_MODES.length];
			state.viewMode = next;
			if (next === 'mark') {
				state.revealed = {};
			}

			localStorage.setItem(VIEW_KEY, next);
			setViewButtonContent(btn);
			render();
		});
		controls.insertBefore(btn, controls.firstChild);
	}

	// Which threads get a widget, and which get a quote highlight
	function threadSets() {
		if (state.viewMode === 'off') {
			return {widgets: [], highlights: []};
		}

		if (state.viewMode === 'mark') {
			return {
				widgets: state.threads.filter(function (thread) {
					return state.revealed[thread.id];
				}),
				highlights: state.threads
			};
		}

		if (state.viewMode === 'open') {
			var unresolved = state.threads.filter(function (thread) {
				return !thread.resolved;
			});
			return {widgets: unresolved, highlights: unresolved};
		}

		return {widgets: state.threads, highlights: state.threads};
	}

	/* ---------- render cycle ---------- */

	// A comment form the reader is typing in, and the editor, survive a
	// re-render. Rebuilding them would drop the caret, an IME composition in
	// progress and, through the focus that followed, the reader's scroll
	// position — on every comments push, which a review produces constantly.
	// Their content is state-driven anyway, so leaving the element alone
	// loses nothing; the row one rides in stays with it. Reply forms live
	// inside their thread's widget and are rebuilt with it, focus restored.
	function keptAcrossRender(node) {
		var widget = node.matches('.marker-form, .marker-editor') ?
			node : node.querySelector('td > .marker-form, td > .marker-editor');
		if (!widget) return false;
		if (widget.classList.contains('marker-editor')) return Boolean(state.editor);
		var textarea = widget.querySelector('textarea[data-draft-key]');
		var key = textarea ? textarea.getAttribute('data-draft-key') : '';
		return key.indexOf('new:') === 0 && Boolean(state.openForms[key]);
	}

	function clearWidgets() {
		unwrapQuotes();
		var stale = document.querySelectorAll(
			'.marker-thread, .marker-thread-row, .marker-form, .marker-editor, #marker-unanchored');
		for (var i = 0; i < stale.length; i++) {
			if (!keptAcrossRender(stale[i])) stale[i].remove();
		}
	}

	function render() {
		clearWidgets();

		var unanchored = [];
		var sets = threadSets();

		sets.widgets.forEach(function (thread) {
			var candidate = anchorFor(thread.lineStart);
			if (!candidate) {
				unanchored.push(thread);
				return;
			}
			var placement = placementFor(candidate.node);
			insertAt(placement, threadWidget(thread, placement.kind !== 'block'));
		});

		sets.highlights.forEach(function (thread) {
			highlightQuote(thread);
		});

		if (unanchored.length > 0) {
			var section = el('div', '');
			section.id = 'marker-unanchored';
			section.setAttribute('data-marker-ui', '');
			section.appendChild(el('h3', '', 'Comments no longer anchored to the text'));
			unanchored.forEach(function (thread) {
				section.appendChild(threadWidget(thread));
			});
			var root = content();
			if (root) root.appendChild(section);
		}

		// Re-open any standalone new-comment forms that hold a draft
		Object.keys(state.openForms).forEach(function (key) {
			if (key.indexOf('new:') !== 0) return;
			if (document.querySelector('[data-draft-key="' + key + '"]')) return;
			insertNewCommentForm(key, null);
		});

		if (state.editor && !document.querySelector('.marker-editor')) {
			var editAnchor = anchorFor(state.editor.anchorLine);
			if (editAnchor) insertAt(placementFor(editAnchor.node), editorPanel());
		}

		restorePendingMarks();
		pinRowWidgets();
		paintHistoryButtons();
		restoreFocus();

		// Widgets and highlights are in place. Features that read them — the
		// mermaid toggle counts unresolved marks for its badge — listen here.
		document.dispatchEvent(new CustomEvent('marker:rendered'));
	}

	function refresh() {
		return fetch(API).then(function (response) {
			return response.json();
		}).then(function (data) {
			state.threads = data.threads || [];
			render();
		}).catch(function () {
			// Daemon unreachable (e.g. stopped) — leave the page as is
		});
	}

	/* ---------- wiring ---------- */

	document.addEventListener('mouseup', function () {
		// Wait a tick so the selection reflects this mouseup
		setTimeout(maybeShowSelectionButton, 0);
	});
	document.addEventListener('keyup', function (event) {
		if (event.key === 'Escape') {
			hideSelectionButton();
			if (!state.editor && !document.querySelector('.marker-form')) clearPending();
			return;
		}
		if (event.shiftKey || (event.key && event.key.indexOf('Arrow') === 0)) {
			setTimeout(maybeShowSelectionButton, 0);
		}
	});

	document.addEventListener('marker:reload', function () {
		// The blocks the bar pointed at went with the old content
		hideSelectionButton();
		pendingSelection = null;
		refresh();
		// The file just changed; an open editor has to say so
		refreshDiskView();
	});
	document.addEventListener('marker:comments', refresh);

	if (!cfg.hotreload) {
		setInterval(function () {
			refresh();
			refreshDiskView();
		}, 5000);
	}

	ensureViewButton();
	refresh();
})();
