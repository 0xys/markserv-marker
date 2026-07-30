'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('ava')
const {JSDOM} = require('jsdom')

const {markdownToHTML} = require('../lib/server')

const MERMAID_JS = fs.readFileSync(
	path.join(__dirname, '..', 'lib', 'templates', 'mermaid.js'), 'utf8')

const MARKDOWN = `# Title

\`\`\`mermaid
graph TD;
  A-->B;
\`\`\`

text between

\`\`\`mermaid
sequenceDiagram
  A->>B: hi
\`\`\`
`

const tick = ms => new Promise(resolve => {
	setTimeout(resolve, ms)
})

// Jsdom cannot run mermaid itself, and does not have to: mermaid.js checks
// window.mermaid before injecting the bundle, so a stub takes that seam.
const stubLib = (window, {fail = false} = {}) => {
	const state = {inits: [], ids: [], sources: []}
	window.mermaid = {
		initialize(options) {
			state.inits.push(options)
		},
		async render(id, source) {
			state.ids.push(id)
			state.sources.push(source)
			if (fail) {
				throw new Error('Parse error on line 2')
			}

			return {svg: `<svg id="${id}"><text>A</text></svg>`}
		}
	}
	return state
}

const buildPage = async ({markdown = MARKDOWN, theme = 'dark', fail = false} = {}) => {
	const contentHtml = await markdownToHTML(markdown)
	const dom = new JSDOM(
		`<!DOCTYPE html><html data-theme="${theme}"><body>
			<article class="markdown-body"><div id="marker-content">${contentHtml}</div></article>
		</body></html>`,
		{url: 'http://localhost:7642/f/abc123/test.md', runScripts: 'outside-only'})

	const {window} = dom
	const lib = stubLib(window, {fail})
	window.eval(MERMAID_JS)
	await tick(20)
	return {window, document: window.document, lib}
}

test('each block gets a diagram and a toggle, both marked as UI', async t => {
	const {document, lib} = await buildPage()

	const wrappers = [...document.querySelectorAll('.marker-mermaid')]
	t.is(wrappers.length, 2)
	t.deepEqual(lib.sources, ['graph TD;\n  A-->B;\n', 'sequenceDiagram\n  A->>B: hi\n'])

	for (const wrapper of wrappers) {
		const diagram = wrapper.querySelector('.marker-mermaid-diagram')
		const toggle = wrapper.querySelector('.marker-mermaid-toggle')
		t.truthy(diagram)
		t.truthy(toggle)
		// Comments.js walks text nodes to match quotes; diagram labels must not
		// join that corpus, or they shift occurrence counting document-wide
		t.is(diagram.dataset.markerUi, '')
		t.is(toggle.dataset.markerUi, '')
		t.truthy(diagram.querySelector('svg'))
		// The source is left exactly as the server rendered it
		t.truthy(wrapper.querySelector('pre.marker-mermaid-source code.language-mermaid'))
	}

	// The wrapper stays commentable: not UI, and carrying no line attributes
	t.is(wrappers[0].dataset.markerUi, undefined)
	t.is(wrappers[0].dataset.sourceLine, undefined)
})

test('the diagram is shown only once a render has succeeded', async t => {
	const {document} = await buildPage()
	t.is(document.querySelector('.marker-mermaid').dataset.mode, 'diagram')
})

test('a block whose diagram fails to render stays on its source', async t => {
	const {document} = await buildPage({fail: true})

	const wrapper = document.querySelector('.marker-mermaid')
	// No data-mode at all: the CSS default leaves the source visible
	t.is(wrapper.dataset.mode, undefined)
	t.falsy(wrapper.querySelector('.marker-mermaid-diagram'))
	t.falsy(wrapper.querySelector('.marker-mermaid-toggle'))

	const error = wrapper.querySelector('.marker-mermaid-error')
	t.truthy(error)
	t.true(error.textContent.includes('Parse error on line 2'))
	t.is(error.dataset.markerUi, '')

	// The other block is unaffected by its neighbour's failure
	t.is(document.querySelectorAll('.marker-mermaid-error').length, 2)
})

test('the toggle switches that block alone between diagram and source', async t => {
	const {window, document} = await buildPage()

	const [first, second] = document.querySelectorAll('.marker-mermaid')
	first.querySelector('.marker-mermaid-toggle')
		.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	await tick(10)

	t.is(first.dataset.mode, 'code')
	t.is(second.dataset.mode, 'diagram')
	t.true(first.querySelector('.marker-mermaid-toggle').textContent.includes('diagram'))

	first.querySelector('.marker-mermaid-toggle')
		.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	await tick(10)
	t.is(first.dataset.mode, 'diagram')
})

test('the chosen view survives a hot-reload content swap', async t => {
	const {window, document} = await buildPage()

	document.querySelector('.marker-mermaid .marker-mermaid-toggle')
		.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	await tick(10)
	t.is(document.querySelector('.marker-mermaid').dataset.mode, 'code')

	// Hot reload replaces the content, so per-block state cannot live in the DOM
	const swapped = await markdownToHTML(MARKDOWN.replace('text between', 'edited prose'))
	document.querySelector('#marker-content').innerHTML = swapped
	document.dispatchEvent(new window.CustomEvent('marker:reload'))
	await tick(20)

	const [first, second] = document.querySelectorAll('.marker-mermaid')
	t.is(first.dataset.mode, 'code')
	t.is(second.dataset.mode, 'diagram')
	t.truthy(first.querySelector('.marker-mermaid-diagram svg'))
})

test('a theme change redraws every diagram with a fresh id', async t => {
	const {window, document, lib} = await buildPage({theme: 'light'})

	t.is(lib.inits[0].theme, 'default')
	const idsBefore = [...lib.ids]

	document.documentElement.dataset.theme = 'solarized'
	document.dispatchEvent(new window.CustomEvent('marker:theme', {detail: {theme: 'solarized'}}))
	await tick(20)

	t.is(lib.inits[1].theme, 'neutral')
	// Mermaid namespaces its arrowhead defs by id, so ids are never reused
	t.is(lib.ids.length, idsBefore.length + 2)
	t.is(new Set(lib.ids).size, lib.ids.length)
	t.is(document.querySelectorAll('.marker-mermaid-diagram').length, 2)
	t.is(document.querySelectorAll('.marker-mermaid-toggle').length, 2)
})

test('unresolved comment highlights put a count on the toggle', async t => {
	const {window, document} = await buildPage()

	const [first, second] = document.querySelectorAll('.marker-mermaid')
	const code = first.querySelector('.marker-mermaid-source code')
	// Two marks of one thread plus one of another: the badge counts threads
	code.innerHTML =
		'<mark class="marker-quote" data-thread-id="abc123-c1">graph</mark> TD;\n' +
		'<mark class="marker-quote" data-thread-id="abc123-c1">A</mark>--&gt;' +
		'<mark class="marker-quote" data-thread-id="abc123-c2">B</mark>;\n'
	second.querySelector('.marker-mermaid-source code').innerHTML =
		'<mark class="marker-quote resolved" data-thread-id="abc123-c3">sequenceDiagram</mark>\n'

	document.dispatchEvent(new window.CustomEvent('marker:rendered'))
	await tick(10)

	t.is(first.querySelector('.marker-mermaid-count').textContent, '2')
	// Resolved threads are done with, so they raise no flag
	t.falsy(second.querySelector('.marker-mermaid-count'))
})

test('documents without a mermaid block are left alone', async t => {
	const {document, lib} = await buildPage({markdown: '# Title\n\njust prose\n'})

	t.deepEqual(lib.inits, [])
	t.deepEqual(lib.ids, [])
	t.falsy(document.querySelector('[data-marker-ui]'))
})
