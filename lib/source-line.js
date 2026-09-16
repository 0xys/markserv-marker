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
// ./mermaid takes mermaid fences over completely, emitting a wrapping <div>
// the injection below could not see through, so it comes after this one and
// stamps the same attributes itself. ./diff-fence also comes after, but keeps
// the injection by wrapping what the captured renderer returns rather than
// replacing it, which is why it stamps nothing. A fence plugin has those three
// choices: sit before this one and emit a bare leading <pre>, sit after it and
// stamp its own attributes, or sit after it and wrap its output.
// Markdown-it 10 maps a table's tbody but not the rows inside it, so a comment
// on one row used to anchor to the whole body — and the UI could only show it
// after the table, having nothing finer to attach to. A GFM table body row is
// exactly one source line, so the k-th row of a body spanning [start, end) is
// line start + k; fill those in and every row becomes its own anchor.
const fillTableRowMaps = tokens => {
	let body = null
	let row = 0

	for (const token of tokens) {
		if (token.type === 'tbody_open') {
			body = token.map
			row = 0
		} else if (token.type === 'tbody_close') {
			body = null
		} else if (token.type === 'tr_open' && body && !token.map) {
			const line = body[0] + row
			// A malformed table could claim more rows than lines; leave those
			// alone rather than pointing past the block
			if (line < body[1]) {
				token.map = [line, line + 1]
			}

			row++
		}
	}
}

module.exports = md => {
	md.core.ruler.push('source_line', state => {
		fillTableRowMaps(state.tokens)

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
