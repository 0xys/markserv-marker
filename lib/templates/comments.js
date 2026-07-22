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
	// break lists/tables: walk up until the parent allows a div child
	function insertionPoint(node) {
		var breakers = {UL: 1, OL: 1, TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, PRE: 1};
		var current = node;
		while (current.parentElement && current.parentElement !== content() &&
			breakers[current.parentElement.tagName]) {
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

	function wrapRawRange(entries, rawStart, rawEnd, threadId, resolved) {
		var marks = [];
		for (var i = 0; i < entries.length; i++) {
			var entry = entries[i];
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

	function highlightQuote(thread, anchorNode) {
		if (!thread.quote) return;
		var collected = textEntries();
		var norm = normalize(collected.raw);
		var needle = normalize(thread.quote).text.trim();
		if (!needle) return;

		// Prefer the occurrence at/after the anchor block, so repeated
		// phrases highlight near the right thread
		var anchorRaw = 0;
		if (anchorNode) {
			for (var i = 0; i < collected.entries.length; i++) {
				if (anchorNode.contains(collected.entries[i].node)) {
					anchorRaw = collected.entries[i].start;
					break;
				}
			}
		}

		var index = -1;
		var searchFrom = 0;
		while ((index = norm.text.indexOf(needle, searchFrom)) !== -1) {
			if (norm.map[index] >= anchorRaw) break;
			searchFrom = index + 1;
		}
		if (index === -1) index = norm.text.indexOf(needle);
		if (index === -1) return;

		var rawStart = norm.map[index];
		var rawEnd = norm.map[index + needle.length - 1] + 1;
		var marks = wrapRawRange(collected.entries, rawStart, rawEnd, thread.id, thread.resolved);

		marks.forEach(function (mark) {
			mark.addEventListener('click', function () {
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

		save.addEventListener('click', function () {
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
		});

		cancel.addEventListener('click', function () {
			delete state.drafts[draftKey];
			delete state.openForms[draftKey];
			if (onCancel) onCancel();
			form.remove();
		});

		actions.appendChild(save);
		actions.appendChild(cancel);
		form.appendChild(textarea);
		form.appendChild(actions);
		setTimeout(function () {
			textarea.focus();
		}, 0);
		return form;
	}

	/* ---------- snapshot diff (side-by-side, GitHub style) ---------- */

	// Generic LCS diff over arrays: returns [{op: ' '|'-'|'+', item}]
	function lcsOps(a, b) {
		var m = a.length;
		var n = b.length;
		var dp = [];
		var i;
		var j;
		for (i = 0; i <= m; i++) {
			dp.push(new Array(n + 1).fill(0));
		}
		for (i = m - 1; i >= 0; i--) {
			for (j = n - 1; j >= 0; j--) {
				dp[i][j] = a[i] === b[j] ?
					dp[i + 1][j + 1] + 1 :
					Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}

		var ops = [];
		i = 0;
		j = 0;
		while (i < m && j < n) {
			if (a[i] === b[j]) {
				ops.push({op: ' ', item: a[i]});
				i++;
				j++;
			} else if (dp[i + 1][j] >= dp[i][j + 1]) {
				ops.push({op: '-', item: a[i]});
				i++;
			} else {
				ops.push({op: '+', item: b[j]});
				j++;
			}
		}
		while (i < m) ops.push({op: '-', item: a[i++]});
		while (j < n) ops.push({op: '+', item: b[j++]});
		return ops;
	}

	function mergeSegments(segments) {
		var merged = [];
		segments.forEach(function (segment) {
			var last = merged[merged.length - 1];
			if (last && last.changed === segment.changed) {
				last.text += segment.text;
			} else {
				merged.push({text: segment.text, changed: segment.changed});
			}
		});
		return merged;
	}

	// Tokenize like GitHub's word diff: Latin words stay whole, CJK is
	// per-character, whitespace and punctuation are their own runs
	var TOKEN_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF]|[A-Za-z0-9_\u00C0-\u024F]+|\s+|[^\sA-Za-z0-9_\u00C0-\u024F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF]+/g;

	function tokenize(str) {
		return str.match(TOKEN_RE) || [];
	}

	// Word-level segments for a paired old/new line: the tokens that
	// actually changed are flagged so they can get the darker background
	function charSegments(oldStr, newStr) {
		var oldTokens = tokenize(oldStr);
		var newTokens = tokenize(newStr);

		if (oldTokens.length * newTokens.length > 160000) {
			// Too long for LCS: fall back to common prefix/suffix
			var p = 0;
			while (p < oldStr.length && p < newStr.length && oldStr[p] === newStr[p]) p++;
			var s = 0;
			while (s < oldStr.length - p && s < newStr.length - p &&
				oldStr[oldStr.length - 1 - s] === newStr[newStr.length - 1 - s]) s++;
			var cut = function (str) {
				return mergeSegments([
					{text: str.slice(0, p), changed: false},
					{text: str.slice(p, str.length - s), changed: true},
					{text: str.slice(str.length - s), changed: false}
				].filter(function (segment) {
					return segment.text.length > 0;
				}));
			};
			return {left: cut(oldStr), right: cut(newStr)};
		}

		var ops = lcsOps(oldTokens, newTokens);
		var left = [];
		var right = [];
		ops.forEach(function (entry) {
			if (entry.op === ' ') {
				left.push({text: entry.item, changed: false});
				right.push({text: entry.item, changed: false});
			} else if (entry.op === '-') {
				left.push({text: entry.item, changed: true});
			} else {
				right.push({text: entry.item, changed: true});
			}
		});
		return {left: mergeSegments(left), right: mergeSegments(right)};
	}

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
					var segments = charSegments(oldLine, newLine);
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

		lcsOps(snapshotText.split('\n'), currentText.split('\n')).forEach(function (entry) {
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
		widget.appendChild(head);

		var bodyWrap = el('div', 'marker-thread-body');

		if (thread.changed && thread.snapshot && thread.currentText !== null) {
			bodyWrap.appendChild(diffNode(thread.snapshot.text, thread.currentText));
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

		pendingSelection = {
			lineStart: lineRangeOf(startBlock).start,
			lineEnd: lineRangeOf(endBlock).end,
			quote: quote,
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
			var candidate = anchorFor(thread.lineStart);
			highlightQuote(thread, candidate && candidate.node);
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
