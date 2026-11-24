/* Math after a hot reload, for markserv-marker pages.
   MathJax typesets the page once, when it starts. A hot reload swaps the
   content of #marker-content for freshly rendered HTML, which carries the
   TeX as text again, so without this every formula falls back to its raw
   \( … \) source on the first edit.

   MathJax loads async and may not have arrived when a reload does: then
   there is nothing to do, since its own startup typesets whatever content is
   there by then. Once it has, the reload waits for any startup typeset still
   in flight, forgets the math items of the content that was replaced, and
   typesets the new one. */
(function () {
	'use strict';

	document.addEventListener('marker:reload', function () {
		var mj = window.MathJax;
		if (!mj || typeof mj.typesetPromise !== 'function') return;
		var el = document.getElementById('marker-content');
		if (!el) return;
		var ready = (mj.startup && mj.startup.promise) || Promise.resolve();
		ready.then(function () {
			// The old content is gone; its items would otherwise be kept
			if (typeof mj.typesetClear === 'function') mj.typesetClear();
			return mj.typesetPromise([el]);
		}).catch(function (err) {
			if (window.console) console.error('MathJax typeset after reload failed', err);
		});
	});
})();
