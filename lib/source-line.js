'use strict'

// Markdown-it plugin that stamps rendered block elements with their source
// line range (1-based, inclusive) as data-source-line / data-source-line-end.
// The comment UI and API anchor comments to these line numbers.
//
// Must be .use()'d AFTER markdown-it-highlightjs: that plugin replaces the
// fence renderer and drops token attrs, so fences get their attributes injected
// into the rendered string by wrapping whatever fence renderer is installed by
// then. The injection only reaches a <pre> at the very start of that string.
//
// ./mermaid is the one plugin that comes after this one: it takes mermaid
// fences over completely, emitting a wrapping <div> the injection below could
// not see through, and stamps the same attributes itself. Any future fence
// plugin has the same choice — sit before this one and emit a bare leading
// <pre>, or sit after it and stamp its own attributes.
module.exports = md => {
	md.core.ruler.push('source_line', state => {
		for (const token of state.tokens) {
			if (!token.map) {
				continue
			}

			const isOpenTag = token.nesting === 1
			const isSelfContained =
				token.type === 'fence' ||
				token.type === 'code_block' ||
				token.type === 'html_block' ||
				token.type === 'hr'

			if (isOpenTag || isSelfContained) {
				token.attrSet('data-source-line', String(token.map[0] + 1))
				token.attrSet('data-source-line-end', String(token.map[1]))
			}
		}
	})

	const fenceRenderer = md.renderer.rules.fence
	md.renderer.rules.fence = (tokens, idx, options, env, self) => {
		const html = fenceRenderer(tokens, idx, options, env, self)
		const token = tokens[idx]
		if (!token.map) {
			return html
		}

		return html.replace(/^(<pre[^>]*)/,
			`$1 data-source-line="${token.map[0] + 1}" data-source-line-end="${token.map[1]}"`)
	}
}
