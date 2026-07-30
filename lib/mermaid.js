'use strict'

// Markdown-it plugin that turns ```mermaid fences into a block the browser can
// show either as a diagram or as its mermaid source.
//
// The inner <pre><code class="language-mermaid"> keeps exactly the shape every
// other fence has, line attributes included, so line anchoring, quote
// re-finding and comment threads work on the source without any special case.
// The wrapper only gives lib/templates/mermaid.js somewhere to hang the
// rendered SVG and the toggle button.
//
// Must be .use()'d AFTER ./source-line: that plugin injects its attributes into
// a <pre> at the very start of the fence output, which this wrapper's <div>
// would silently hide. So mermaid fences bypass it and stamp their own.
//
// No call to options.highlight either, which is what silences highlight.js
// complaining that it has never heard of a language called mermaid.
module.exports = md => {
	const fenceRenderer = md.renderer.rules.fence

	md.renderer.rules.fence = (tokens, idx, options, env, self) => {
		const token = tokens[idx]
		const language = (token.info || '').trim().split(/\s+/)[0].toLowerCase()
		if (language !== 'mermaid' || !token.map) {
			return fenceRenderer(tokens, idx, options, env, self)
		}

		const lines = `data-source-line="${token.map[0] + 1}" data-source-line-end="${token.map[1]}"`

		// Ignore classes for MathJax 2 and 3 keep it off labels containing $…$
		return '<div class="marker-mermaid tex2jax_ignore mathjax_ignore" data-marker-wrapper>' +
			`<pre ${lines} class="marker-mermaid-source">` +
			`<code ${lines} class="language-mermaid">${md.utils.escapeHtml(token.content)}</code>` +
			'</pre></div>\n'
	}
}
