'use strict'

// Markdown-it plugin that fixes where an auto-linkified URL ends in Japanese
// prose. linkify-it does not treat CJK punctuation as a boundary, so
// "…https://example.com/z。" swallows the 。 into the href, and
// "（https://example.com/y）です" swallows ）です as well.
//
// Cutting at the FIRST CJK punctuation rather than trimming the tail is what
// makes the second case work: it does not end in punctuation, so a tail-only
// trim leaves it broken. Cutting on punctuation only — never on word
// characters — is what keeps https://ja.wikipedia.org/wiki/日本語 intact.
//
// Only links linkify produced are touched. markdown-it tags link_open with
// `markup`: 'linkify' here, 'autolink' for <URL>, and '' for [text](url), so
// URLs the author delimited themselves are left exactly as written.
//
// Deliberately NOT shared with the character class in server.js's slugify:
// that one strips punctuation out of heading slugs, and widening or narrowing
// it would change existing heading ids, breaking anchor links and the TOC.
// This set answers a different question — where does a URL stop — and needs
// characters such as ・ that slug hygiene does not care about.
const CJK_PUNCTUATION =
	/[\u3000。？！，、；：“”【】（）〔〕［］﹃﹄‘’﹁﹂—…－～《》〈〉「」『』・]/

module.exports = md => {
	md.core.ruler.push('linkify_cjk', state => {
		for (const token of state.tokens) {
			if (token.type !== 'inline' || !token.children) {
				continue
			}

			const {children} = token
			for (let i = 0; i < children.length; i++) {
				const open = children[i]
				if (open.type !== 'link_open' || open.markup !== 'linkify') {
					continue
				}

				const text = children[i + 1]
				const close = children[i + 2]
				if (text?.type !== 'text' || close?.type !== 'link_close') {
					continue
				}

				const at = text.content.search(CJK_PUNCTUATION)
				if (at <= 0) {
					continue
				}

				const url = text.content.slice(0, at)
				const rest = text.content.slice(at)
				text.content = url
				open.attrSet('href', state.md.normalizeLink(url))

				// The cut characters go back into the document as text, so the
				// rendered text stays identical. Comment quotes are matched by
				// string comparison against it, so losing a character here
				// would move every anchor after it.
				const tail = new state.Token('text', '', 0)
				tail.content = rest
				children.splice(i + 3, 0, tail)
			}
		}
	})
}
