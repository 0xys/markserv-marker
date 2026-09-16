/* The path strip above the page frame, on a document page and on a folder
   listing alike.

   A long path keeps its leading directories and the last two segments,
   collapsing the middle to an ellipsis segment; hovering shows the full path
   in a tooltip (CSS ::before over data-path) and a click copies it.

   The name of the folder one level up is a link to that folder's listing, so
   the reader who wants the neighbouring files does not have to go round by
   the index. It is offered only where there is somewhere to go: /f/<id>/ is
   the served root and as far up as resolveWithin allows, so the link exists
   exactly when the URL has a segment below it to drop — which is every
   document page, and every folder page except the root's own. */
(function () {
	'use strict';

	var el = document.getElementById('marker-file-path');
	if (!el) return;

	var full = el.getAttribute('data-path') || '';
	if (!full) {
		el.remove();
		return;
	}

	// A folder page names the folder itself, a document page the file; either
	// way the segment before that name is the folder one level up
	var isFolder = el.hasAttribute('data-folder');
	var MAX = 64;

	function shortened(path) {
		if (path.length <= MAX) return path;
		var parts = path.split('/');
		var tail = parts.slice(-2).join('/'); // The folder above, and the name
		var kept = [];
		for (var i = 0; i < parts.length - 2; i++) {
			var candidate = kept.concat([parts[i]]).join('/') + '/…/' + tail;
			if (candidate.length > MAX) break;
			kept.push(parts[i]);
		}

		return kept.join('/') + '/…/' + tail;
	}

	function span(className, text) {
		var node = document.createElement('span');
		node.className = className;
		node.textContent = text;
		return node;
	}

	// This page's URL with its last segment dropped, or '' when that would
	// leave the served root behind
	function upHref() {
		var parts = location.pathname.replace(/\/+$/, '').split('/');
		if (parts.length <= 3) return '';
		return parts.slice(0, -1).join('/') + '/';
	}

	var display = shortened(full);
	var cut = display.lastIndexOf('/') + 1;
	var dirText = display.slice(0, cut);
	var upCut = dirText.lastIndexOf('/', dirText.length - 2) + 1;
	var folder = dirText.slice(upCut, cut - 1);
	var up = upHref();

	if (up && folder && folder !== '…') {
		el.appendChild(span('marker-file-path-dir', dirText.slice(0, upCut)));
		var link = document.createElement('a');
		link.className = 'marker-file-path-up';
		link.href = up;
		link.title = 'Open this folder';
		link.textContent = folder;
		el.appendChild(link);
		el.appendChild(span('marker-file-path-sep', '/'));
	} else {
		el.appendChild(span('marker-file-path-dir', dirText));
	}

	el.appendChild(span('marker-file-path-base', display.slice(cut)));
	// A trailing slash says the bold name is a folder, as the heading does
	if (isFolder) el.appendChild(span('marker-file-path-sep', '/'));

	el.addEventListener('click', function (event) {
		// The folder link is the one part of the strip that is not the copy
		if (event.target.closest('.marker-file-path-up')) return;
		if (!navigator.clipboard) return;
		navigator.clipboard.writeText(full).then(function () {
			el.classList.add('copied');
			setTimeout(function () {
				el.classList.remove('copied');
			}, 1200);
		});
	});
})();
