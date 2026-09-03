/* Sticky table headers for markserv-marker pages.
   A long table's header scrolls out of sight and the columns stop meaning
   anything, so the header row pins to the top of the window while the page
   scrolls past it.

   Which is only possible for some tables. The github-markdown theme gives
   every table `overflow: auto` so a wide one can scroll sideways inside the
   column, and that makes the table its own scroll container: a sticky header
   inside it pins to the table's box, which scrolls away with the page, so
   nothing appears to happen. Turning the overflow off is what lets the header
   pin to the window — but then a table too wide for the column spills out of
   the page instead of scrolling, taking the page's own horizontal scrollbar
   with it.

   So the choice is per table, and it needs measuring rather than guessing:
   with the overflow still on, a table that reports no horizontal scrolling to
   do is one that can give it up, and its header pins to the window.

   A table that does need to scroll sideways gets the other treatment: keep
   the overflow, cap the height, and the header pins to the top of the table's
   own box while the rows scroll inside it. Only worth doing to a table taller
   than most of the window, and only that far — letting cells break inside a
   long word would make such a table fit, and was tried, but it squeezes the
   columns until identifiers break mid-word (ETHMaxFeePerGas over three lines),
   which costs more than it buys.

   Re-measured on hot reload and on resize, since the same table can outgrow
   its column when the window narrows. */
(function () {
	'use strict';

	var PAGE = 'marker-sticky-head';   // header pins to the window
	var INNER = 'marker-scroll-head';  // header pins inside the table's own box
	// Below this a table fits on screen anyway and needs neither
	var TALL = 0.7;

	function content() {
		return document.getElementById('marker-content');
	}

	function tables() {
		var root = content();
		if (!root) return [];
		return [].slice.call(root.querySelectorAll('table')).filter(function (table) {
			// The side-by-side view of a diff block is a table of its own making
			return !table.closest('[data-marker-ui]');
		});
	}

	function apply() {
		var all = tables();

		// Measure with the theme's overflow back in place, or a table that has
		// already given it up reports nothing to scroll and keeps the header
		// however wide it has since become. The height cap has to go too, or a
		// capped table measures its cap instead of itself.
		all.forEach(function (table) {
			table.classList.remove(PAGE);
			table.classList.remove(INNER);
		});

		all.forEach(function (table) {
			if (!table.tHead) return;
			if (table.scrollWidth - table.clientWidth <= 1) {
				table.classList.add(PAGE);
				return;
			}

			if (table.getBoundingClientRect().height > window.innerHeight * TALL) {
				table.classList.add(INNER);
			}
		});
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

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', apply);
	} else {
		apply();
	}
})();
