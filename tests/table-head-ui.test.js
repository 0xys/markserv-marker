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
		// PretendToBeVisual, because the scroll sync runs in a
		// requestAnimationFrame and jsdom has none without it
		{url: 'http://localhost:7642/f/abc123/test.md', runScripts: 'outside-only', pretendToBeVisual: true})

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
	t.is(document.querySelectorAll('.marker-sticky-shell').length, 0)
})

// A table that keeps its sideways scrolling cannot hold a header that sticks
// to the window, so its header row is copied into a fixed shell that follows
// the table's own scrolling.
const straddlesTop = (table, rect) => {
	Object.defineProperty(table, 'getBoundingClientRect', {
		value: () => rect,
		configurable: true
	})
}

test('a table that must scroll sideways gets a fixed copy of its header', async t => {
	const {window, document} = await buildPage()

	const table = document.querySelector('#marker-content table')
	needsHorizontalScroll(table, true)
	window.dispatchEvent(new window.Event('resize'))
	await tick(200)

	t.false(table.classList.contains('marker-sticky-head'))
	const shell = document.querySelector('.marker-sticky-shell')
	t.truthy(shell)
	// Out of the content, so its text is nowhere near the quote corpus, but
	// inside the article, or none of the theme's table rules reach it
	t.is(shell.parentElement, document.querySelector('article.markdown-body'))
	t.falsy(shell.closest('#marker-content'))
	t.is(shell.dataset.markerUi, '')
	// A copy of the header row, and only that
	t.is(shell.querySelectorAll('thead').length, 1)
	t.is(shell.querySelectorAll('tbody').length, 0)
	t.is(shell.querySelectorAll('th').length, table.tHead.querySelectorAll('th').length)
})

test('the copy shows only while the table straddles the top edge', async t => {
	const {window, document} = await buildPage()

	const table = document.querySelector('#marker-content table')
	needsHorizontalScroll(table, true)
	window.dispatchEvent(new window.Event('resize'))
	await tick(200)
	const shell = document.querySelector('.marker-sticky-shell')

	// Below the fold: nothing to pin yet
	straddlesTop(table, {
		top: 300, bottom: 900, left: 40, right: 440, width: 400, height: 600
	})
	window.dispatchEvent(new window.Event('scroll'))
	await tick(60)
	t.is(shell.style.display, 'none')

	// Scrolled into: pinned, aligned to the table's own left edge and width
	straddlesTop(table, {
		top: -200, bottom: 400, left: 40, right: 440, width: 400, height: 600
	})
	window.dispatchEvent(new window.Event('scroll'))
	await tick(60)
	t.is(shell.style.display, 'block')
	t.is(shell.style.left, '40px')
	t.is(shell.style.width, table.clientWidth + 'px')

	// Scrolled past: gone again
	straddlesTop(table, {
		top: -900, bottom: -300, left: 40, right: 440, width: 400, height: 600
	})
	window.dispatchEvent(new window.Event('scroll'))
	await tick(60)
	t.is(shell.style.display, 'none')
})

test('the copy is slid sideways by the table\'s own scrolling', async t => {
	const {window, document} = await buildPage()

	const table = document.querySelector('#marker-content table')
	needsHorizontalScroll(table, true)
	straddlesTop(table, {
		top: -200, bottom: 400, left: 40, right: 440, width: 400, height: 600
	})
	window.dispatchEvent(new window.Event('resize'))
	await tick(200)

	table.scrollLeft = 120
	table.dispatchEvent(new window.Event('scroll', {bubbles: true}))
	await tick(60)

	const clone = document.querySelector('.marker-sticky-clone')
	t.is(clone.style.left, '-120px')
	t.is(clone.style.width, table.scrollWidth + 'px')
})

test('copies are rebuilt, not stacked up, on hot reload', async t => {
	const {window, document} = await buildPage()

	const table = document.querySelector('#marker-content table')
	needsHorizontalScroll(table, true)
	window.dispatchEvent(new window.Event('resize'))
	await tick(200)
	t.is(document.querySelectorAll('.marker-sticky-shell').length, 1)

	// Still the same table, still too wide: one copy, not two
	document.dispatchEvent(new window.CustomEvent('marker:reload'))
	await tick(60)
	t.is(document.querySelectorAll('.marker-sticky-shell').length, 1)

	// And when there is room again the copy goes and CSS takes over
	needsHorizontalScroll(table, false)
	document.dispatchEvent(new window.CustomEvent('marker:reload'))
	await tick(60)
	t.is(document.querySelectorAll('.marker-sticky-shell').length, 0)
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
