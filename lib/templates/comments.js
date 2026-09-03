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
		threads: [],
		drafts: {},     // draftKey -> {text, lineStart, lineEnd, quote}
		openForms: {},  // draftKey -> true (form should be open after rebuild)
		collapsed: {},  // threadId -> user override (default: resolved => collapsed)
		revealed: {},   // threadId -> true (thread opened by clicking its mark, in 'mark' mode)
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
					throw new Error((data && data.error && data.error.message) || ('HTTP ' + response.status));
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

	// Insert after the anchor, but behind any widgets already sitting there —
	// threads arrive sorted by line, so this keeps same-block comments in
	// ascending line order instead of each new one cutting in at the top
	function insertAfterAnchor(anchorNode, element) {
		var target = insertionPoint(anchorNode);
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

	function wrapRawRange(entries, rawStart, rawEnd, threadId, resolved) {
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

			var mark = el('mark', 'marker-quote' + (resolved ? ' resolved' : ''));
			mark.setAttribute('data-thread-id', threadId);
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

	function highlightQuote(thread) {
		if (!thread.quote) return;
		var collected = textEntries();
		var norm = normalize(collected.raw);
		var needle = normalize(thread.quote).text.trim();
		if (!needle) return;

		var occurrences = occurrencesOf(norm, needle);
		if (occurrences.length === 0) return;

		// Prefer, in order: the selected occurrence inside the commented line
		// range, then the first one after that region starts, then the first
		// at all. quoteIndex says which occurrence in the region was selected,
		// so two identical words in one block do not collapse onto the first.
		var region = lineRangeRegion(collected.entries, thread.lineStart, thread.lineEnd);
		var chosen = null;
		if (region) {
			var inside = occurrences.filter(function (occurrence) {
				return occurrence.rawStart >= region.start && occurrence.rawEnd <= region.end;
			});
			if (inside.length > 0) {
				var wanted = Number.isInteger(thread.quoteIndex) ? thread.quoteIndex : 0;
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

		var marks = wrapRawRange(collected.entries, chosen.rawStart, chosen.rawEnd, thread.id, thread.resolved);

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
			if (onCancel) onCancel();
			form.remove();
		});

		actions.appendChild(save);
		actions.appendChild(cancel);
		actions.appendChild(hint);
		form.appendChild(textarea);
		form.appendChild(actions);
		setTimeout(function () {
			textarea.focus();
		}, 0);
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
			var tr = el('tr', '');
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

	function threadWidget(thread) {
		var widget = el('div', 'marker-thread' + (thread.resolved ? ' resolved' : ''));
		widget.setAttribute('data-marker-ui', '');
		widget.setAttribute('data-thread-id', thread.id);

		// Collapsed unless the user toggled it; resolved threads start collapsed
		var isCollapsed = Object.prototype.hasOwnProperty.call(state.collapsed, thread.id) ?
			state.collapsed[thread.id] : thread.resolved;

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

		replyLink.addEventListener('click', openReply);
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

	/* ---------- selection -> comment button ---------- */

	var selectionButton = null;
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

	function ensureSelectionButton() {
		if (selectionButton) return selectionButton;
		selectionButton = el('button', 'marker-select-btn', '💬 Comment');
		selectionButton.setAttribute('data-marker-ui', '');
		// Mousedown, not click: mousedown on the button would otherwise
		// collapse the selection before a click can fire
		selectionButton.addEventListener('mousedown', function (event) {
			event.preventDefault();
			event.stopPropagation();
			if (pendingSelection) openSelectionForm(pendingSelection);
			hideSelectionButton();
			var selection = window.getSelection();
			if (selection) selection.removeAllRanges();
		});
		document.body.appendChild(selectionButton);
		return selectionButton;
	}

	function hideSelectionButton() {
		if (selectionButton) selectionButton.style.display = 'none';
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
		var button = ensureSelectionButton();
		button.style.display = 'block';
		button.style.top = (window.scrollY + rect.bottom + 6) + 'px';
		button.style.left = (window.scrollX + Math.max(rect.left, 8)) + 'px';
	}

	function openSelectionForm(sel) {
		var draftKey = 'new:' + sel.lineStart + ':' + sel.lineEnd;
		state.drafts[draftKey] = state.drafts[draftKey] || {};
		state.drafts[draftKey].lineStart = sel.lineStart;
		state.drafts[draftKey].lineEnd = sel.lineEnd;
		state.drafts[draftKey].quote = sel.quote;
		state.drafts[draftKey].quoteIndex = sel.quoteIndex;
		state.openForms[draftKey] = true;

		var existing = document.querySelector('[data-draft-key="' + draftKey + '"]');
		if (existing) {
			existing.focus();
			return;
		}

		insertNewCommentForm(draftKey, sel.endBlock);
	}

	function insertNewCommentForm(draftKey, endBlock) {
		var draft = state.drafts[draftKey];
		if (!draft) return;

		var anchor = endBlock || (anchorFor(draft.lineStart) || {}).node;
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
		insertAfterAnchor(anchor, form);
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

	function clearWidgets() {
		unwrapQuotes();
		var stale = document.querySelectorAll('.marker-thread, .marker-form, #marker-unanchored');
		for (var i = 0; i < stale.length; i++) stale[i].remove();
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
			insertAfterAnchor(candidate.node, threadWidget(thread));
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
			return;
		}
		if (event.shiftKey || event.key.indexOf('Arrow') === 0) {
			setTimeout(maybeShowSelectionButton, 0);
		}
	});

	document.addEventListener('marker:reload', refresh);
	document.addEventListener('marker:comments', refresh);

	if (!cfg.hotreload) {
		setInterval(refresh, 5000);
	}

	ensureViewButton();
	refresh();
})();
