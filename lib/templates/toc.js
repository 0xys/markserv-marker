/* Table-of-contents sidebar for markserv-marker markdown pages.
   Collects h1/h2 from the rendered content into a fixed panel on the
   right; clicking an entry scrolls to the heading. Rebuilds after hot
   reload swaps the content (marker:reload). */
(function () {
	'use strict';

	function content() {
		return document.getElementById('marker-content');
	}

	function build() {
		var existing = document.querySelector('.marker-toc');
		if (existing) existing.remove();
		document.body.classList.remove('has-toc');

		var root = content();
		if (!root) return;

		var headings = [];
		var nodes = root.querySelectorAll('h1, h2');
		for (var i = 0; i < nodes.length; i++) {
			if (nodes[i].closest('[data-marker-ui]')) continue;
			headings.push(nodes[i]);
		}

		if (headings.length < 2) return;
		document.body.classList.add('has-toc');

		var nav = document.createElement('nav');
		nav.className = 'marker-toc';
		nav.setAttribute('data-marker-ui', '');

		var title = document.createElement('div');
		title.className = 'marker-toc-title';
		title.textContent = 'Contents';
		nav.appendChild(title);

		var list = document.createElement('ul');

		headings.forEach(function (heading) {
			var item = document.createElement('li');
			item.className = 'marker-toc-' + heading.tagName.toLowerCase();

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

		nav.appendChild(list);
		document.body.appendChild(nav);
	}

	document.addEventListener('marker:reload', build);

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', build);
	} else {
		build();
	}
})();
