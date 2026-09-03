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

// The theme's overflow is what a sticky header has to give up, and a table too
// wide for the column needs it more: it would spill out of the page instead.
test('a table that must scroll sideways is left alone', async t => {
	const {window, document} = await buildPage()

	const table = document.querySelector('#marker-content table')
	needsHorizontalScroll(table, true)
	window.dispatchEvent(new window.Event('resize'))
	await tick(200)
	t.false(table.classList.contains('marker-sticky-head'))

	// And gets it back when there is room again
	needsHorizontalScroll(table, false)
	window.dispatchEvent(new window.Event('resize'))
	await tick(200)
	t.true(table.classList.contains('marker-sticky-head'))
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
