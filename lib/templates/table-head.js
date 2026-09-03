/* Sticky table headers for markserv-marker pages.
   A long table's header scrolls out of sight and the columns stop meaning
   anything, so the header row stays at the top of the window while the page
   scrolls past the table.

   Two mechanisms, because one does not cover both kinds of table.

   The github-markdown theme gives every table `overflow: auto` so a wide one
   can scroll sideways inside the column, and that makes the table its own
   scroll container: a sticky header inside it pins to the table's box, which
   scrolls away with the page, so nothing appears to happen. For a table that
   reports no sideways scrolling to do, dropping the overflow is enough — CSS
   does the rest, and marker-sticky-head is that.

   A table that does need to scroll sideways cannot have it: there is no way
   to be a horizontal scroll container and let a descendant stick to the
   viewport. `overflow-y: clip` looks like the way out, since the spec does
   not coerce it to auto the way it does visible, but a scrolling value on the
   other axis computes it to hidden, which is still a scroll container. So
   those tables get a copy of their header row in a fixed, clipped shell that
   follows the table's own horizontal scrolling — the standard answer, and the
   only one that keeps the page scrolling normally.

   The shells live in the <article>, but outside #marker-content: outside, so
   their text is nowhere near the corpus comments.js matches quotes against,
   and inside the article because every rule that makes a table look like one
   is written as `.markdown-body table…`. On <body> the copy came out in the
   browser's default serif with no background at all. They take no pointer
   events either: the header they copy is the one you can select. */
(function () {
	'use strict';

	var PAGE = 'marker-sticky-head';
	// Below this much of the header showing, the table has all but left
	var KEEP = 24;

	var shells = [];
	var frame = null;

	function content() {
		return document.getElementById('marker-content');
	}

	function tables() {
		var root = content();
		if (!root) return [];
		return [].slice.call(root.querySelectorAll('table')).filter(function (table) {
			// The side-by-side view of a diff block is a table of its own making
			return !table.closest('[data-marker-ui]') && table.tHead;
		});
	}

	function dropShells() {
		shells.forEach(function (entry) {
			entry.shell.remove();
		});
		shells = [];
	}

	function addShell(table) {
		var shell = document.createElement('div');
		shell.className = 'marker-sticky-shell';
		shell.setAttribute('data-marker-ui', '');

		var clone = document.createElement('table');
		clone.className = table.className + ' marker-sticky-clone';
		clone.setAttribute('data-marker-ui', '');
		clone.append(table.tHead.cloneNode(true));

		shell.append(clone);
		// Inside the article, or the theme's table rules do not reach it
		(document.querySelector('article.markdown-body') || document.body).append(shell);
		shells.push({table: table, shell: shell, clone: clone});
	}

	function sync() {
		shells.forEach(function (entry) {
			var box = entry.table.getBoundingClientRect();
			// Only while the table straddles the top edge with room to show
			if (box.top >= 0 || box.bottom < KEEP) {
				entry.shell.style.display = 'none';
				return;
			}

			entry.shell.style.display = 'block';
			entry.shell.style.left = box.left + 'px';
			entry.shell.style.width = entry.table.clientWidth + 'px';
			entry.clone.style.width = entry.table.scrollWidth + 'px';
			// Follows the table sideways, so the header stays over its columns
			entry.clone.style.left = (-entry.table.scrollLeft) + 'px';

			var real = entry.table.tHead.querySelectorAll('th, td');
			var copy = entry.clone.querySelectorAll('th, td');
			for (var i = 0; i < real.length && i < copy.length; i++) {
				copy[i].style.width = real[i].getBoundingClientRect().width + 'px';
			}
		});
	}

	function syncSoon() {
		if (frame) return;
		frame = requestAnimationFrame(function () {
			frame = null;
			sync();
		});
	}

	function apply() {
		dropShells();
		var all = tables();

		// Measure with the theme's overflow back in place, or a table that has
		// already given it up reports nothing to scroll however wide it has
		// since become
		all.forEach(function (table) {
			table.classList.remove(PAGE);
		});

		all.forEach(function (table) {
			if (table.scrollWidth - table.clientWidth <= 1) {
				table.classList.add(PAGE);
				return;
			}

			addShell(table);
		});

		sync();
	}

	var pending = null;

	function applySoon() {
		if (pending) clearTimeout(pending);
		pending = setTimeout(function () {
			pending = null;
			apply();
		}, 120);
	}

	document.addEventListener('marker:reload', apply);
	// Widgets land inside table rows, which can change a table's width
	document.addEventListener('marker:rendered', applySoon);
	window.addEventListener('resize', applySoon);
	window.addEventListener('scroll', syncSoon, {passive: true});
	// A table scrolling sideways moves its own header, not the page's
	document.addEventListener('scroll', syncSoon, {passive: true, capture: true});

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', apply);
	} else {
		apply();
	}
})();
