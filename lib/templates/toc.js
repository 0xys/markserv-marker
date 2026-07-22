/* Table-of-contents overlay for markserv-marker markdown pages.
   Collects h1/h2/h3 from the rendered content. A handle rides on the
   panel's left edge: it pokes out at the screen edge while the panel is
   hidden, and slides along with it. Hovering the right edge reveals the
   panel; clicking the handle pins it open (persisted in localStorage).
   Rebuilds after hot reload swaps the content (marker:reload). */
(function () {
	'use strict';

	var PIN_KEY = 'markserv-marker-toc-pinned';

	function content() {
		return document.getElementById('marker-content');
	}

	function build() {
		var stale = document.querySelectorAll('.marker-toc, .marker-toc-zone');
		for (var k = 0; k < stale.length; k++) stale[k].remove();

		var root = content();
		if (!root) return;

		var headings = [];
		var nodes = root.querySelectorAll('h1, h2, h3');
		for (var i = 0; i < nodes.length; i++) {
			if (nodes[i].closest('[data-marker-ui]')) continue;
			headings.push(nodes[i]);
		}

		if (headings.length < 2) return;

		// Invisible hover strip along the right edge
		var zone = document.createElement('div');
		zone.className = 'marker-toc-zone';
		zone.setAttribute('data-marker-ui', '');

		var nav = document.createElement('nav');
		nav.className = 'marker-toc';
		nav.setAttribute('data-marker-ui', '');

		var pinned = localStorage.getItem(PIN_KEY) === '1';
		if (pinned) nav.classList.add('pinned');

		// The handle hangs off the panel's left edge and moves with it
		var handle = document.createElement('button');
		handle.className = 'marker-toc-handle';

		function paintHandle() {
			var isPinned = nav.classList.contains('pinned');
			handle.textContent = isPinned ? '✕' : '≡';
			handle.title = isPinned ? 'Unpin the table of contents' : 'Pin the table of contents open';
		}

		handle.addEventListener('click', function () {
			var isPinned = nav.classList.toggle('pinned');
			localStorage.setItem(PIN_KEY, isPinned ? '1' : '0');
			paintHandle();
		});
		paintHandle();
		nav.appendChild(handle);

		var body = document.createElement('div');
		body.className = 'marker-toc-body';

		var title = document.createElement('div');
		title.className = 'marker-toc-title';
		title.textContent = 'Contents';
		body.appendChild(title);

		var list = document.createElement('ul');

		headings.forEach(function (heading) {
			var item = document.createElement('li');
			item.className = 'marker-toc-' + heading.tagName.toLowerCase();
			item.setAttribute('data-line', heading.getAttribute('data-source-line') || '');

			var link = document.createElement('a');
			link.textContent = heading.textContent;
			link.href = heading.id ? '#' + heading.id : 'javascript:void(0)';
			link.addEventListener('click', function (event) {
				event.preventDefault();
				if (typeof heading.scrollIntoView === 'function') {
					heading.scrollIntoView({behavior: 'smooth', block: 'start'});
				}
				if (heading.id && window.history && window.history.replaceState) {
					window.history.replaceState(null, '', '#' + heading.id);
				}
			});

			item.appendChild(link);
			list.appendChild(item);
		});

		body.appendChild(list);
		nav.appendChild(body);
		document.body.appendChild(zone);
		document.body.appendChild(nav);
	}

	// Per-section unresolved-comment badges. A thread belongs to the nearest
	// heading at or above its anchor line. Only on registered-file pages
	// (window.__marker) — silently skipped elsewhere.
	function updateCounts() {
		var cfg = window.__marker;
		var nav = document.querySelector('.marker-toc');
		if (!cfg || !cfg.fileId || !nav || typeof fetch !== 'function') return;

		fetch(cfg.apiBase + '/files/' + cfg.fileId + '/comments?resolved=false')
			.then(function (response) {
				return response.json();
			})
			.then(function (data) {
				var oldBadges = nav.querySelectorAll('.marker-toc-count');
				for (var b = 0; b < oldBadges.length; b++) oldBadges[b].remove();

				var items = nav.querySelectorAll('li');
				var lines = [];
				for (var i = 0; i < items.length; i++) {
					lines.push(parseInt(items[i].getAttribute('data-line'), 10));
				}

				var counts = new Array(items.length).fill(0);
				(data.threads || []).forEach(function (thread) {
					var owner = -1;
					for (var j = 0; j < lines.length; j++) {
						if (!isNaN(lines[j]) && lines[j] <= thread.lineStart) owner = j;
					}
					if (owner !== -1) counts[owner]++;
				});

				for (var n = 0; n < items.length; n++) {
					if (counts[n] === 0) continue;
					var badge = document.createElement('span');
					badge.className = 'marker-toc-count';
					badge.textContent = counts[n];
					badge.title = counts[n] + ' unresolved comment' + (counts[n] > 1 ? 's' : '');
					items[n].appendChild(badge);
				}
			})
			.catch(function () {});
	}

	function rebuild() {
		build();
		updateCounts();
	}

	document.addEventListener('marker:reload', rebuild);
	document.addEventListener('marker:comments', updateCounts);

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', rebuild);
	} else {
		rebuild();
	}
})();
