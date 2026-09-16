'use strict'

const test = require('ava')

const {markdownToHTML} = require('../lib/server')

const WRAPPER = '<div class="marker-diffblock tex2jax_ignore mathjax_ignore" data-marker-wrapper>'

const DIFF = [
	'```diff',
	'--- a/x.js',
	'+++ b/x.js',
	'@@ -1,2 +1,2 @@',
	'-const b = 2',
	'+const b = 3',
	'```',
	''
].join('\n')

// The wrapper is only somewhere for the browser to hang the side-by-side view.
// The <pre>/<code> inside must stay indistinguishable from any other fence so
// the comment machinery needs no special case — which is why this plugin wraps
// the previous renderer's output instead of replacing it.
test('a diff fence is wrapped, keeping an ordinary highlighted pre/code inside', async t => {
	const html = await markdownToHTML(DIFF)

	t.true(html.includes(WRAPPER))
	t.true(html.includes('<pre data-source-line="1" data-source-line-end="7">'))
	t.true(html.includes(
		'<code data-source-line="1" data-source-line-end="7" class="language-diff">'))

	// Highlighting of the source view is untouched
	t.true(html.includes('<span class="hljs-deletion">-const b = 2</span>'))
	t.true(html.includes('<span class="hljs-addition">+const b = 3</span>'))

	// Line attributes belong on the pre/code, never on the wrapper: the wrapper
	// would become a rival anchor candidate for the same lines
	t.notRegex(html, /<div class="marker-diffblock[^>]*data-source-line/)
	// Which view to show is the browser's call, made once a parse succeeds
	t.false(html.includes('data-mode'))
	// Marking the wrapper as UI would make its source uncommentable
	t.notRegex(html, /<div class="marker-diffblock[^>]*data-marker-ui/)
})

test('a patch fence is wrapped too, and matching is on the first word', async t => {
	const patch = await markdownToHTML('```patch\n-a\n+b\n```\n')
	t.true(patch.includes(WRAPPER))
	t.true(patch.includes('class="language-patch"'))

	const upper = await markdownToHTML('```DIFF\n-a\n+b\n```\n')
	t.true(upper.includes(WRAPPER))

	// A different language that merely starts with the same letters. Silenced
	// because highlight.js has never heard of it and says so.
	const original = console.error
	console.error = () => {}
	let other
	try {
		other = await markdownToHTML('```diffy\n-a\n+b\n```\n')
	} finally {
		console.error = original
	}

	t.false(other.includes('marker-diffblock'))
})

test('other fences and mermaid blocks are untouched', async t => {
	const js = await markdownToHTML('```js\nvar a = 1\n```\n')
	t.false(js.includes('marker-diffblock'))
	t.true(js.includes('<pre data-source-line="1" data-source-line-end="3">'))
	t.true(js.includes('hljs-keyword'))

	// The diff plugin wraps mermaid's renderer, so mermaid must still win its
	// own fences and keep emitting its own wrapper
	const mermaid = await markdownToHTML('```mermaid\ngraph TD;\n```\n')
	t.false(mermaid.includes('marker-diffblock'))
	t.true(mermaid.includes('<div class="marker-mermaid tex2jax_ignore mathjax_ignore" data-marker-wrapper>'))
})

test('an indented diff fence inside a list keeps its own line range', async t => {
	const html = await markdownToHTML('- step\n\n  ```diff\n  -a\n  +b\n  ```\n')

	t.true(html.includes(WRAPPER))
	t.true(html.includes('<pre data-source-line="3" data-source-line-end="6"'))
})

// The regression guard for the plugin's registration order. Registered before
// ./source-line this plugin's <div> hides the <pre> from that plugin's string
// injection, and the block silently loses the line attributes the whole
// comment machinery anchors on.
test('a document with both fence kinds keeps every wrapper and anchor', async t => {
	const html = await markdownToHTML(
		'```mermaid\ngraph TD;\n```\n\n```diff\n-a\n+b\n```\n')

	t.true(html.includes('<div class="marker-mermaid tex2jax_ignore mathjax_ignore" data-marker-wrapper>'))
	t.true(html.includes(
		'<pre data-source-line="1" data-source-line-end="3" class="marker-mermaid-source">'))

	t.true(html.includes(WRAPPER))
	t.true(html.includes('<pre data-source-line="5" data-source-line-end="8">'))
})
