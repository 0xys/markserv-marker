'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('ava')
const {JSDOM} = require('jsdom')

const {markdownToHTML} = require('../lib/server')

const CODE_BLOCK_JS = fs.readFileSync(
	path.join(__dirname, '..', 'lib', 'templates', 'code-block.js'), 'utf8')
const COMMENTS_JS = fs.readFileSync(
	path.join(__dirname, '..', 'lib', 'templates', 'comments.js'), 'utf8')
const DIFF_CORE_JS = fs.readFileSync(
	path.join(__dirname, '..', 'lib', 'templates', 'diff-core.js'), 'utf8')

const MARKDOWN = `# Title

\`\`\`js
const a = 1;
\`\`\`

    indented code

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

\`\`\`diff
-old
+new
\`\`\`

\`\`\`
plain
\`\`\`
`

const tick = ms => new Promise(resolve => {
	setTimeout(resolve, ms)
})

const buildPage = async ({markdown = MARKDOWN, threads = null} = {}) => {
	const contentHtml = await markdownToHTML(markdown)
	const dom = new JSDOM(
		`<!DOCTYPE html><html><body>
			<article class="markdown-body"><div id="marker-content">${contentHtml}</div></article>
			<div class="page-controls"></div>
		</body></html>`,
		{url: 'http://localhost:7642/f/abc123/test.md', runScripts: 'outside-only'})

	const {window} = dom
	if (threads) {
		window.__marker = {fileId: 'abc123', apiBase: '/api', hotreload: true}
		window.fetch = () => Promise.resolve({
			ok: true, status: 200,
			json: () => Promise.resolve({fileId: 'abc123', threads})
		})
	}

	window.eval(CODE_BLOCK_JS)
	if (threads) {
		window.eval(DIFF_CORE_JS)
		window.eval(COMMENTS_JS)
	}

	await tick(20)
	return {window, document: window.document}
}

// Jsdom lays nothing out; a block that overflows has to say so itself
const overflows = (pre, does) => {
	Object.defineProperty(pre, 'scrollWidth', {value: does ? 900 : 400, configurable: true})
	Object.defineProperty(pre, 'clientWidth', {value: 400, configurable: true})
}

const reload = async (page, markdown = MARKDOWN) => {
	page.document.querySelector('#marker-content').innerHTML = await markdownToHTML(markdown)
	page.document.dispatchEvent(new page.window.CustomEvent('marker:reload'))
	await tick(20)
}

test('plain code blocks are wrapped; blocks another feature owns are not', async t => {
	const {document} = await buildPage()

	const wrappers = [...document.querySelectorAll('.marker-codeblock')]
	// The js fence, the indented block and the bare fence
	t.is(wrappers.length, 3)
	for (const wrapper of wrappers) {
		t.is(wrapper.dataset.markerWrapper, '')
		// Not UI: the code inside is content, and comments are made on it
		t.is(wrapper.dataset.markerUi, undefined)
		t.is(wrapper.querySelectorAll('pre').length, 1)
		t.is(wrapper.dataset.mode, 'scroll')
	}

	t.falsy(document.querySelector('.marker-mermaid .marker-codeblock'))
	t.falsy(document.querySelector('.marker-diffblock .marker-codeblock'))
	// And the source-line anchors stay on the pre, where anchorFor looks
	t.is(document.querySelector('.marker-codeblock pre').dataset.sourceLine, '3')
})

test('the toggle is UI, hidden until the block has lines running past its edge', async t => {
	const {window, document} = await buildPage()
	const wrapper = document.querySelector('.marker-codeblock')
	const toggle = wrapper.querySelector('.marker-codeblock-toggle')
	t.truthy(toggle)
	t.is(toggle.dataset.markerUi, '')
	t.true(toggle.hidden)

	overflows(wrapper.querySelector('pre'), true)
	window.dispatchEvent(new window.Event('resize'))
	await tick(200)
	t.false(toggle.hidden)
	// The label names the view being shown
	t.is(toggle.textContent, '↔ scroll')
})

test('a click wraps that block, names the new view, and becomes the default for blocks built later', async t => {
	const page = await buildPage()
	const {window, document} = page
	const [first, second] = document.querySelectorAll('.marker-codeblock')
	overflows(first.querySelector('pre'), true)

	first.querySelector('.marker-codeblock-toggle').click()
	t.is(first.dataset.mode, 'wrap')
	t.is(first.querySelector('.marker-codeblock-toggle').textContent, '↩ wrap')
	// A wrapped block keeps its button, or it could not go back
	t.false(first.querySelector('.marker-codeblock-toggle').hidden)
	// The block beside it is untouched
	t.is(second.dataset.mode, 'scroll')
	t.is(window.localStorage.getItem('markserv-marker-code-lines'), 'wrap')

	// A reload rebuilds the blocks, and each keeps the mode it had, by its
	// ordinal; a block the document did not have before resolves to the
	// remembered default, as every block of a freshly opened page does
	await reload(page, MARKDOWN + '\n```\nnew block\n```\n')
	t.deepEqual([...document.querySelectorAll('.marker-codeblock')].map(w => w.dataset.mode),
		['wrap', 'scroll', 'scroll', 'wrap'])

	// And a click back is remembered too
	document.querySelector('.marker-codeblock-toggle').click()
	t.is(window.localStorage.getItem('markserv-marker-code-lines'), 'scroll')
})

test('a reload rebuilds the wrappers once each', async t => {
	const page = await buildPage()
	await reload(page)
	await reload(page)

	const {document} = page
	t.is(document.querySelectorAll('.marker-codeblock').length, 3)
	t.is(document.querySelectorAll('.marker-codeblock .marker-codeblock').length, 0)
	for (const wrapper of document.querySelectorAll('.marker-codeblock')) {
		t.is(wrapper.querySelectorAll('.marker-codeblock-toggle').length, 1)
	}
})

test('a thread on a code block lands after the whole block, not among its controls', async t => {
	const thread = {
		id: 'abc123-c1',
		fileId: 'abc123',
		lineStart: 4,
		lineEnd: 4,
		quote: 'const a = 1;',
		parentId: null,
		author: 'reviewer',
		body: 'On the code',
		createdAt: '2026-07-21T00:00:00.000Z',
		resolved: false,
		replies: []
	}
	const {document} = await buildPage({threads: [thread]})

	const widget = document.querySelector('.marker-thread')
	t.truthy(widget)
	t.true(widget.previousElementSibling.classList.contains('marker-codeblock'))
	t.is(widget.parentElement.id, 'marker-content')
	// The quote is still highlighted inside the wrapped pre — one mark per
	// highlighted token, together the whole line
	t.is([...document.querySelectorAll('.marker-codeblock mark.marker-quote')]
		.map(mark => mark.textContent).join(''), 'const a = 1;')
})
