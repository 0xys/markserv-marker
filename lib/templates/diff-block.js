/* Side-by-side view of a ```diff block for markserv-marker pages.
   lib/diff-fence.js wraps a diff fence in .marker-diffblock, leaving the
   ordinary <pre><code> of its source inside. This script parses that unified
   diff and draws the two-column comparison beside it, then adds a button that
   switches the block between the two. Comments are made on the source, so the
   unified view is where the comment UI works; the button carries a badge when
   the block has unresolved comments.

   Everything created here is marked data-marker-ui. That is not cosmetic:
   comments.js collects every text node under #marker-content to match quotes
   against, and this view repeats the block's text verbatim — unmarked, it
   would double every string and shift quoteIndex counting for the whole
   document. The wrapper itself is left unmarked on purpose: marking it would
   make its source uncommentable.

   The comparison is progressive enhancement. The server emits no data-mode,
   CSS shows the source by default, and the mode attribute only appears once a
   parse has actually found a diff. */
(function () {
	'use strict';

	// '0' would be ambiguous here, so the view names itself
	var KEY = 'markserv-marker-diff-view'; // 'split' (default) | 'unified'

	// Per-block view mode, keyed by the block's ordinal position among the diff
	// blocks of the document. Hot reload replaces #marker-content wholesale, so
	// anything kept on the elements themselves is lost; the ordinal survives
	// edits to the prose around the blocks.
	var modes = {};
	// Parse results by the same key, so switching back to the comparison does
	// not have to read and parse the source again
	var parses = {};

	function content() {
		return document.getElementById('marker-content');
	}

	function blocks() {
		var root = content();
		return root ? [].slice.call(root.querySelectorAll('.marker-diffblock')) : [];
	}

	function preferred() {
		return localStorage.getItem(KEY) === 'unified' ? 'unified' : 'split';
	}

	function el(tag, className, text) {
		var node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.appendChild(document.createTextNode(text));
		node.setAttribute('data-marker-ui', '');
		return node;
	}

	function sourceOf(wrapper) {
		var code = wrapper.querySelector('pre > code');
		// textContent, not innerHTML: comment highlights inject <mark> in here
		return code ? code.textContent : '';
	}

	/* ---------- parsing a unified diff ---------- */

	// Counts are optional in a hunk header and mean 1 when omitted
	var HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
	// A combined diff of a merge carries one column per parent, so its body
	// lines have several markers. Half-rendering that as a two-way comparison
	// would be worse than not rendering it.
	var COMBINED_RE = /^@@@/;
	// The shapes git puts between files, recognised only outside a hunk body
	var FILE_HEADER_RE = /^(diff --git |index |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files )/;
	// Past this the browser is better off leaving the source alone: every pair
	// of changed lines costs an LCS over its words
	var ROW_CAP = 3000;
	// Monospace columns one side gets inside the body column, gutters removed
	var IN_COLUMN_COLUMNS = 55;

	// How wide the widest compared line is, in monospace columns, so the CSS
	// can be told whether this block has earned the room to spread out. CJK
	// takes two columns per character, which is most of the point of counting
	// rather than measuring string length.
	var WIDE_RE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;

	function columns(text) {
		var total = 0;
		for (var i = 0; i < text.length; i++) {
			total += WIDE_RE.test(text.charAt(i)) ? 2 : 1;
		}

		return total;
	}

	function sideColumns(side) {
		if (!side) return 0;
		if (!side.segs) return columns(side.text);
		return side.segs.reduce(function (total, segment) {
			return total + columns(segment.text);
		}, 0);
	}

	function widest(rows) {
		return rows.reduce(function (most, row) {
			if (row.kind === 'ctx') return Math.max(most, columns(row.text));
			if (row.kind !== 'pair') return most;
			return Math.max(most, sideColumns(row.left), sideColumns(row.right));
		}, 0);
	}

	// Rows are {kind: 'meta'|'hunk'|'pair'|'ctx'|'note', ...}. A 'pair' holds
	// one row of the table: either side may be absent, which is how GitHub
	// shows an unmatched deletion or addition.
	function parse(source) {
		var lines = source.replace(/\n$/, '').split('\n').map(function (line) {
			// A patch pasted from a CRLF file keeps the carriage return
			return line.charAt(line.length - 1) === '\r' ? line.slice(0, -1) : line;
		});

		if (lines.some(function (line) {
			return COMBINED_RE.test(line);
		})) {
			return {ok: false, reason: 'combined'};
		}

		// A fence holding nothing but -/+ lines is the common hand-written
		// case and still worth comparing; it just has no line numbers to show.
		// Without a header there is no hunk to be outside of, so the body
		// starts immediately.
		var numbered = lines.some(function (line) {
			return HUNK_RE.test(line);
		});

		var rows = [];
		var dels = [];
		var adds = [];
		var oldNo = 0;
		var newNo = 0;
		var oldLeft = 0;
		var newLeft = 0;
		var inBody = !numbered;
		var changes = 0;
		var notes = [];

		// "\ No newline" arrives in the middle of a -/+ run, between the two
		// lines it sits between, so it is held until the run it belongs to has
		// been paired up. Emitting it straight away would put it above the
		// rows it annotates and break the pairing at the same time.
		function emitNotes() {
			notes.forEach(function (text) {
				rows.push({kind: 'note', text: text});
			});
			notes = [];
		}

		function flush() {
			var count = Math.max(dels.length, adds.length);
			for (var k = 0; k < count; k++) {
				var left = dels[k];
				var right = adds[k];
				if (left && right) {
					var segments = window.markerDiff.charSegments(left.text, right.text);
					rows.push({
						kind: 'pair',
						left: {no: left.no, segs: segments.left, type: 'del'},
						right: {no: right.no, segs: segments.right, type: 'add'}
					});
				} else if (left) {
					rows.push({kind: 'pair', left: {no: left.no, text: left.text, type: 'del'}, right: null});
				} else {
					rows.push({kind: 'pair', left: null, right: {no: right.no, text: right.text, type: 'add'}});
				}
			}

			dels = [];
			adds = [];
			emitNotes();
		}

		lines.forEach(function (line) {
			var hunk = HUNK_RE.exec(line);
			if (hunk) {
				flush();
				oldNo = parseInt(hunk[1], 10);
				newNo = parseInt(hunk[3], 10);
				oldLeft = hunk[2] === undefined ? 1 : parseInt(hunk[2], 10);
				newLeft = hunk[4] === undefined ? 1 : parseInt(hunk[4], 10);
				inBody = true;
				rows.push({kind: 'hunk', text: line});
				return;
			}

			if (line.charAt(0) === '\\') {
				// Not a line of either file, so it consumes no line number.
				// Checked before the body test because it follows a hunk's last
				// line, by which point the hunk's counts have run out.
				notes.push(line);
				return;
			}

			// Outside a hunk body every line is furniture. Inside one, even a
			// line starting with --- is a deletion, which is why the hunk's own
			// counts decide where the body ends rather than a pattern.
			if (!inBody) {
				flush();
				if (line !== '') rows.push({kind: 'meta', text: line});
				return;
			}

			// A headerless block has no counts to end a body with, so the file
			// headers someone wrote above their -/+ lines are recognised until
			// the first change. A deletion of a line that itself starts with
			// "--- " loses this coin toss.
			if (!numbered && changes === 0 &&
				(FILE_HEADER_RE.test(line) || line.indexOf('--- ') === 0 || line.indexOf('+++ ') === 0)) {
				rows.push({kind: 'meta', text: line});
				return;
			}

			var marker = line.charAt(0);

			if (marker === '-') {
				dels.push({no: oldNo++, text: line.slice(1)});
				changes++;
				oldLeft--;
			} else if (marker === '+') {
				adds.push({no: newNo++, text: line.slice(1)});
				changes++;
				newLeft--;
			} else {
				// A context line. The marker is dropped only when it is really
				// there: a hand-written block often writes context flush left,
				// and slicing that would eat the first character of the line.
				// An empty line is such a case too, where an editor trimmed the
				// single leading space.
				flush();
				rows.push({
					kind: 'ctx',
					oldNo: oldNo++,
					newNo: newNo++,
					text: marker === ' ' ? line.slice(1) : line
				});
				oldLeft--;
				newLeft--;
			}

			if (numbered && oldLeft <= 0 && newLeft <= 0) {
				inBody = false;
			}
		});

		flush();
		if (changes === 0) {
			return {ok: false, reason: 'not-a-diff'};
		}

		if (rows.length > ROW_CAP) {
			return {ok: false, reason: 'too-large'};
		}

		return {rows: rows, numbered: numbered, widest: widest(rows), ok: true};
	}

	/* ---------- drawing the table ---------- */

	// Which of the two sides a cell belongs to. A selection dragged across
	// rows becomes a cell selection, so without this the other side's text
	// comes along; see selectionSide below.
	function gutter(no, numbered, which) {
		return el('td', 'marker-diffblock-no marker-diffblock-' + which,
			numbered && no ? String(no) : '');
	}

	function cell(side, numbered, which) {
		if (!side) {
			return [
				gutter(null, false, which),
				el('td', 'marker-diffblock-cell empty marker-diffblock-' + which)
			];
		}

		var body = el('td',
			'marker-diffblock-cell ' + side.type + ' marker-diffblock-' + which);
		if (side.segs) {
			side.segs.forEach(function (segment) {
				if (segment.changed) {
					body.appendChild(el('span', 'chg', segment.text));
				} else {
					body.appendChild(document.createTextNode(segment.text));
				}
			});
		} else {
			body.appendChild(document.createTextNode(side.text));
		}

		return [gutter(side.no, numbered, which), body];
	}

	function wideRow(className, text) {
		var tr = el('tr', '');
		var td = el('td', className, text);
		td.setAttribute('colspan', '4');
		tr.appendChild(td);
		return tr;
	}

	function tableFor(parsed) {
		var table = el('table',
			'marker-diffblock-table' + (parsed.numbered ? '' : ' no-numbers'));

		// Column widths come from here, not from the first row: with a fixed
		// table layout a leading full-width header row would otherwise hand
		// the gutters a quarter of the block each.
		var group = el('colgroup', '');
		['no', 'text', 'no', 'text'].forEach(function (kind) {
			group.appendChild(el('col', 'marker-diffblock-col-' + kind));
		});
		table.appendChild(group);

		var body = el('tbody', '');

		parsed.rows.forEach(function (row) {
			if (row.kind === 'meta' || row.kind === 'hunk' || row.kind === 'note') {
				body.appendChild(wideRow('marker-diffblock-' + row.kind, row.text));
				return;
			}

			var tr = el('tr', '');
			if (row.kind === 'ctx') {
				tr.appendChild(gutter(row.oldNo, parsed.numbered, 'old'));
				tr.appendChild(el('td', 'marker-diffblock-cell ctx marker-diffblock-old', row.text));
				tr.appendChild(gutter(row.newNo, parsed.numbered, 'new'));
				tr.appendChild(el('td', 'marker-diffblock-cell ctx marker-diffblock-new', row.text));
			} else {
				cell(row.left, parsed.numbered, 'old').forEach(function (node) {
					tr.appendChild(node);
				});
				cell(row.right, parsed.numbered, 'new').forEach(function (node) {
					tr.appendChild(node);
				});
			}

			body.appendChild(tr);
		});

		table.appendChild(body);
		return table;
	}

	/* ---------- the toggle ---------- */

	function toggleOf(wrapper, index) {
		var existing = wrapper.querySelector('.marker-diffblock-toggle');
		if (existing) return existing;

		var button = el('button', 'marker-diffblock-toggle');
		button.appendChild(el('span', 'marker-diffblock-toggle-label'));
		button.addEventListener('click', function () {
			var next = wrapper.getAttribute('data-mode') === 'split' ? 'unified' : 'split';
			modes[index] = next;
			// Remembered as the default for later page loads. Blocks resolve
			// their mode when they are built, so this does not reach the ones
			// already on the page.
			localStorage.setItem(KEY, next);
			applyModes();
		});
		wrapper.appendChild(button);
		return button;
	}

	function paintToggle(wrapper) {
		var button = wrapper.querySelector('.marker-diffblock-toggle');
		if (!button) return;

		// The label says which view this is, not what the button does: read as
		// an action it looks like a state, and mistaking one for the other is
		// exactly what it costs. What a click does is in the tooltip.
		var showsSplit = wrapper.getAttribute('data-mode') === 'split';
		var label = button.querySelector('.marker-diffblock-toggle-label');
		if (label) label.textContent = showsSplit ? '⇆ split' : '</> unified';
		button.title = showsSplit ?
			'Showing the two sides side by side. Click for the unified diff source, where comments can be made.' :
			'Showing the unified diff source. Click to compare the two sides.';

		// Unresolved threads are the reason to go and read the source, so their
		// count rides on the button. Counted from the highlights comments.js
		// left behind rather than fetched again — one thread can own several.
		var ids = {};
		var marks = wrapper.querySelectorAll('mark.marker-quote:not(.resolved)');
		for (var i = 0; i < marks.length; i++) {
			ids[marks[i].getAttribute('data-thread-id')] = 1;
		}

		var count = Object.keys(ids).length;
		var badge = button.querySelector('.marker-diffblock-count');
		if (count === 0) {
			if (badge) badge.remove();
			return;
		}

		if (!badge) {
			badge = el('span', 'marker-diffblock-count');
			button.appendChild(badge);
		}

		badge.textContent = count;
		badge.title = count + ' unresolved comment' + (count > 1 ? 's' : '');
	}

	// The comparison exists only while it is the view being shown. Hiding it
	// with CSS instead left it in the DOM between the source and the toggle,
	// and a selection dragged out past the end of a line — which is where the
	// toggle floats — ran on through it, pulling the other side's text and the
	// line numbers into the quote and landing its endpoint inside marked-up UI,
	// where the Comment button will not offer itself at all.
	function applyModes() {
		blocks().forEach(function (wrapper, index) {
			var parsed = parses[index];
			// Blocks that held no diff have nothing to compare and stay as source
			if (!parsed) return;

			var mode = modes[index] === 'unified' ? 'unified' : 'split';
			wrapper.setAttribute('data-mode', mode);

			var view = wrapper.querySelector('.marker-diffblock-view');
			if (mode === 'unified') {
				if (view) view.remove();
			} else {
				if (!view) {
					view = el('div', 'marker-diffblock-view');
					// Before the toggle, which is the wrapper's last child
					wrapper.insertBefore(view, wrapper.querySelector('.marker-diffblock-toggle'));
				}

				view.textContent = '';
				view.appendChild(tableFor(parsed));
			}

			paintToggle(wrapper);
		});
	}

	// Why a block was left as source, when the reason is not simply that it
	// held no diff. Said out loud, because a missing toggle is otherwise
	// indistinguishable from the feature being broken.
	var REASONS = {
		combined: 'Combined diff of a merge: shown as its source, not side by side',
		'too-large': 'Too many lines to compare side by side: shown as its source'
	};

	function renderBlock(wrapper, index) {
		var parsed = parse(sourceOf(wrapper));
		var stale = wrapper.querySelector('.marker-diffblock-view');
		var reason = wrapper.querySelector('.marker-diffblock-reason');
		if (reason) reason.remove();

		if (!parsed.ok) {
			// Not a comparison after all: leave the source alone, no toggle
			delete parses[index];
			if (stale) stale.remove();
			var staleToggle = wrapper.querySelector('.marker-diffblock-toggle');
			if (staleToggle) staleToggle.remove();
			wrapper.removeAttribute('data-mode');
			wrapper.classList.remove('is-wide');
			if (REASONS[parsed.reason]) {
				wrapper.appendChild(el('div', 'marker-diffblock-reason', REASONS[parsed.reason]));
			}

			return;
		}

		// Kept so applyModes can build the comparison on demand: it is only in
		// the DOM while it is the view being shown
		parses[index] = parsed;

		// Two columns of this block's widest line, plus the gutters, against
		// the ~918px the body column offers at 12px monospace. A small diff
		// spanning the whole window reads as a mistake, so it stays put.
		wrapper.classList.toggle('is-wide', parsed.widest > IN_COLUMN_COLUMNS);

		if (modes[index] === undefined) modes[index] = preferred();
		toggleOf(wrapper, index);
	}

	function renderAll() {
		blocks().forEach(renderBlock);
		applyModes();
	}

	/* ---------- keeping a selection to one side ---------- */

	// A selection that leaves the cell it started in becomes a cell selection,
	// and the browser then hands over every cell it touches — so dragging down
	// one column copies the other column's text along with it, interleaved.
	// The side the drag starts on wins: the other one is made unselectable for
	// the duration, which is how GitHub keeps its split diff copyable.
	function selectionSide(event) {
		var target = event.target;
		if (!target || !target.closest) return;

		var view = target.closest('.marker-diffblock-view');
		if (!view) return;

		// A file or hunk header belongs to neither side. Locking to the old one
		// anyway keeps a drag that starts there from picking up both columns,
		// which is the whole point of locking.
		var cell = target.closest('td');
		var side = cell && cell.classList.contains('marker-diffblock-new') ? 'new' : 'old';

		view.classList.toggle('select-old', side === 'old');
		view.classList.toggle('select-new', side === 'new');
	}

	/* ---------- wiring ---------- */

	document.addEventListener('mousedown', selectionSide, true);
	document.addEventListener('marker:reload', renderAll);
	// Widgets and highlights have just been rebuilt: refresh the badges
	document.addEventListener('marker:rendered', applyModes);

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', renderAll);
	} else {
		renderAll();
	}
})();
