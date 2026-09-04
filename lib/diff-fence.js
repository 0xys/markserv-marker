'use strict'

// Markdown-it plugin that marks ```diff fences as a block the browser can show
// either as a side-by-side comparison or as the unified source it was written
// as. Only the wrapper is added here; lib/templates/diff-block.js draws the
// two-column view into it.
//
// Unlike ./mermaid this does NOT bypass the renderer it replaces: it calls the
// captured one and wraps the result. That keeps highlight.js colouring the
// source, and it keeps ./source-line's attributes, which that renderer has
// already injected into the leading <pre>. So the inner <pre><code> is
// byte-for-byte the shape every other fence has, and line anchoring, quote
// re-finding and comment threads work on the diff source with no special case.
//
// Must therefore be .use()'d after ./source-line, and after ./mermaid so that
// plugin still sees the fence renderer it expects to wrap.
const DIFF_LANGUAGES = new Set(['diff', 'patch'])

module.exports = md => {
	const fenceRenderer = md.renderer.rules.fence

	md.renderer.rules.fence = (tokens, idx, options, env, self) => {
		const html = fenceRenderer(tokens, idx, options, env, self)
		const token = tokens[idx]
		const language = (token.info || '').trim().split(/\s+/)[0].toLowerCase()
		if (!DIFF_LANGUAGES.has(language) || !token.map) {
			return html
		}

		// No data-source-line on the wrapper: it would become a rival anchor
		// candidate for the same lines as the <pre> it holds.
		//
		// The ignore classes keep MathJax 2 and 3 out of the block. Its default
		// skip list covers pre and code, which is why fences are safe today,
		// but the side-by-side view is a table: a patch touching $FOO would
		// otherwise get typeset into it.
		return '<div class="marker-diffblock tex2jax_ignore mathjax_ignore" ' +
			`data-marker-wrapper>${html}</div>\n`
	}
}
