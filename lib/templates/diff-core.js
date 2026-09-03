/* Text diff primitives shared by markserv-marker's browser features.

   Two features compare text and need the same answers: comments.js draws the
   snapshot diff inside a thread widget when the commented lines have changed,
   and diff-block.js draws the side-by-side view of a ```diff block. Only the
   algorithms live here — everything DOM-shaped stays with the feature that
   owns it, because the two build different rows: one has two cells, the other
   carries old and new line numbers in gutters.

   Loaded before both, and before comments.js in particular. */
(function () {
	'use strict';

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

	window.markerDiff = {
		lcsOps: lcsOps,
		mergeSegments: mergeSegments,
		tokenize: tokenize,
		charSegments: charSegments
	};
})();
