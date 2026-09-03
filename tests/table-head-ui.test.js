'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('ava')
const {JSDOM} = require('jsdom')

const {markdownToHTML} = require('../lib/server')

const TABLE_HEAD_JS = fs.readFileSync(
	path.join(__dirname, '..', 'lib', 'templates', 'table-head.js'), 'utf8')

const MARKDOWN = `# Title

| # | label |
|---|---|
| 1 | one |
| 2 | two |
`

const tick = ms => new Promise(resolve => {
	setTimeout(resolve, ms)
})

const buildPage = async ({markdown = MARKDOWN} = {}) => {
	const contentHtml = await markdownToHTML(markdown)
	const dom = new JSDOM(
		`<!DOCTYPE html><html data-theme="dark"><body>
			<article class="markdown-body"><div id="marker-content">${contentHtml}</div></article>
		</body></html>`,
		{url: 'http://localhost:7642/f/abc123/test.md', runScripts: 'outside-only'})

	const {window} = dom
	window.eval(TABLE_HEAD_JS)
	await tick(10)
	return {window, document: window.document}
}

// Jsdom reports 0 for both, which reads as "nothing to scroll sideways"
const needsHorizontalScroll = (table, needs) => {
	Object.defineProperty(table, 'scrollWidth', {value: needs ? 900 : 400, configurable: true})
	Object.defineProperty(table, 'clientWidth', {value: 400, configurable: true})
}

test('a table that fits gets the sticky header class', async t => {
	const {document} = await buildPage()

	const table = document.querySelector('#marker-content table')
	t.true(table.classList.contains('marker-sticky-head'))
})

// A table that has to keep its sideways scrolling gets the other treatment:
// its own scroll box, with the header pinned to the top of that. Worth it only
// for a table taller than most of the window; a short one fits on screen.
const isTall = (table, tall) => {
	Object.defineProperty(table, 'getBoundingClientRect', {
		value: () => ({
			top: 0, left: 0, right: 400, bottom: tall ? 2000 : 100, width: 400, height: tall ? 2000 : 100
		}),
		configurable: true
	})
}

test('a wide, tall table scrolls inside itself instead', async t => {
	const {window, document} = await buildPage()

	const table = document.querySelector('#marker-content table')
	needsHorizontalScroll(table, true)
	isTall(table, true)
	window.dispatchEvent(new window.Event('resize'))
	await tick(200)
	t.false(table.classList.contains('marker-sticky-head'))
	t.true(table.classList.contains('marker-scroll-head'))
})

test('a wide but short table is left alone entirely', async t => {
	const {window, document} = await buildPage()

	const table = document.querySelector('#marker-content table')
	needsHorizontalScroll(table, true)
	isTall(table, false)
	window.dispatchEvent(new window.Event('resize'))
	await tick(200)
	t.false(table.classList.contains('marker-sticky-head'))
	t.false(table.classList.contains('marker-scroll-head'))
})

test('a table wins the window-level header back when there is room again', async t => {
	const {window, document} = await buildPage()

	const table = document.querySelector('#marker-content table')
	needsHorizontalScroll(table, true)
	isTall(table, true)
	window.dispatchEvent(new window.Event('resize'))
	await tick(200)
	t.true(table.classList.contains('marker-scroll-head'))

	needsHorizontalScroll(table, false)
	window.dispatchEvent(new window.Event('resize'))
	await tick(200)
	t.true(table.classList.contains('marker-sticky-head'))
	t.false(table.classList.contains('marker-scroll-head'))
})

test('a table with no header row has nothing to stick', async t => {
	const {window, document} = await buildPage()

	const bare = document.createElement('table')
	bare.innerHTML = '<tbody><tr><td>a</td></tr></tbody>'
	document.querySelector('#marker-content').append(bare)
	document.dispatchEvent(new window.CustomEvent('marker:reload'))
	await tick(10)

	t.false(bare.classList.contains('marker-sticky-head'))
})

test('a table another feature drew is not touched', async t => {
	const {window, document} = await buildPage()

	// What the side-by-side view of a diff block looks like
	const view = document.createElement('div')
	view.dataset.markerUi = ''
	view.innerHTML = '<table><thead><tr><th>old</th><th>new</th></tr></thead>' +
		'<tbody><tr><td>a</td><td>b</td></tr></tbody></table>'
	document.querySelector('#marker-content').append(view)
	document.dispatchEvent(new window.CustomEvent('marker:reload'))
	await tick(10)

	t.false(view.querySelector('table').classList.contains('marker-sticky-head'))
	// The document's own table still has it
	t.true(document.querySelector('#marker-content > table').classList.contains('marker-sticky-head'))
})

test('the classes are rebuilt after a hot-reload content swap', async t => {
	const {window, document} = await buildPage()

	const swapped = await markdownToHTML(MARKDOWN.replace('two', 'zwei'))
	document.querySelector('#marker-content').innerHTML = swapped
	document.dispatchEvent(new window.CustomEvent('marker:reload'))
	await tick(10)

	const table = document.querySelector('#marker-content table')
	t.true(table.textContent.includes('zwei'))
	t.true(table.classList.contains('marker-sticky-head'))
})
