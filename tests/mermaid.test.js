'use strict'

const test = require('ava')

const {markdownToHTML} = require('../lib/server')

const WRAPPER = '<div class="marker-mermaid tex2jax_ignore mathjax_ignore" data-marker-wrapper>'

// The wrapper is what lets the browser draw a diagram beside the source; the
// <pre>/<code> inside must stay indistinguishable from any other fence so the
// comment machinery needs no special case.
test('a mermaid fence is wrapped, keeping an ordinary pre/code inside', async t => {
	const html = await markdownToHTML('```mermaid\ngraph TD;\n  A-->B;\n```\n')

	t.true(html.includes(WRAPPER))
	t.true(html.includes(
		'<pre data-source-line="1" data-source-line-end="4" class="marker-mermaid-source">'))
	t.true(html.includes(
		'<code data-source-line="1" data-source-line-end="4" class="language-mermaid">'))
	t.true(html.includes('graph TD;\n  A--&gt;B;\n'))

	// Line attributes belong on the pre/code, never on the wrapper: the wrapper
	// would become a rival anchor candidate for the same lines
	t.notRegex(html, /<div class="marker-mermaid[^>]*data-source-line/)
	// Which view to show is the browser's call, made once a render succeeds
	t.false(html.includes('data-mode'))
	// Marking the wrapper as UI would make its source uncommentable
	t.notRegex(html, /<div class="marker-mermaid[^>]*data-marker-ui/)
})

test('mermaid source is HTML-escaped', async t => {
	const html = await markdownToHTML('```mermaid\ngraph TD;\n  A["<b>&</b>"]-->B;\n```\n')

	t.true(html.includes('A[&quot;&lt;b&gt;&amp;&lt;/b&gt;&quot;]--&gt;B;'))
	t.false(html.includes('<b>'))
})

test('other fences are untouched and still highlighted', async t => {
	const html = await markdownToHTML('```js\nvar a = 1\n```\n')

	t.false(html.includes('marker-mermaid'))
	t.true(html.includes('<pre data-source-line="1" data-source-line-end="3">'))
	t.true(html.includes('hljs-keyword'))
})

test('the info string is matched on its first word, case-insensitively', async t => {
	const upper = await markdownToHTML('```MERMAID\ngraph TD;\n```\n')
	t.true(upper.includes(WRAPPER))

	const extra = await markdownToHTML('```mermaid  {theme: dark}\ngraph TD;\n```\n')
	t.true(extra.includes(WRAPPER))

	// A different language that merely starts with the same letters
	const other = await markdownToHTML('```mermaidjs\ngraph TD;\n```\n')
	t.false(other.includes('marker-mermaid'))
})

test('an indented mermaid fence inside a list keeps its own line range', async t => {
	const html = await markdownToHTML('- step\n\n  ```mermaid\n  graph TD;\n  ```\n')

	t.true(html.includes(WRAPPER))
	t.true(html.includes('<pre data-source-line="3" data-source-line-end="5"'))
})

test('rendering a mermaid fence logs nothing: highlight.js is never asked', async t => {
	const calls = []
	const original = console.error
	console.error = (...args) => calls.push(args.join(' '))
	try {
		await markdownToHTML('```mermaid\ngraph TD;\n  A-->B;\n```\n')
	} finally {
		console.error = original
	}

	t.deepEqual(calls, [])
})
