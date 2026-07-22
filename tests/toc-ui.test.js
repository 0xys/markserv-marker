'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('ava')
const {JSDOM} = require('jsdom')

const {markdownToHTML} = require('../lib/server')

const TOC_JS = fs.readFileSync(
	path.join(__dirname, '..', 'lib', 'templates', 'toc.js'), 'utf8')

const tick = ms => new Promise(resolve => {
	setTimeout(resolve, ms)
})

const buildPage = async (markdown, threadStore) => {
	const contentHtml = await markdownToHTML(markdown)
	const dom = new JSDOM(
		`<!DOCTYPE html><html><body>
			<article class="markdown-body"><div id="marker-content">${contentHtml}</div></article>
		</body></html>`,
		{url: 'http://localhost:7642/f/abc123/test.md', runScripts: 'outside-only'})

	if (threadStore) {
		dom.window.__marker = {fileId: 'abc123', apiBase: '/api', hotreload: true}
		dom.window.fetch = () => Promise.resolve({
			json: () => Promise.resolve({fileId: 'abc123', threads: threadStore.threads})
		})
	}

	dom.window.eval(TOC_JS)
	await tick(10)
	return dom.window
}

const FIXTURE = `# First

intro

## Alpha

text

## Beta

text

### Deep heading

# Second
`

test('the sidebar lists h1-h3 in document order', async t => {
	const window = await buildPage(FIXTURE)
	const {document} = window

	const nav = document.querySelector('.marker-toc')
	t.truthy(nav)
	// Hover strip is a sibling; the handle rides inside the panel
	t.truthy(document.querySelector('.marker-toc-zone'))
	t.truthy(nav.querySelector('.marker-toc-handle'))

	const items = [...nav.querySelectorAll('li')]
	t.deepEqual(items.map(item => item.textContent),
		['First', 'Alpha', 'Beta', 'Deep heading', 'Second'])
	t.deepEqual(items.map(item => item.className),
		['marker-toc-h1', 'marker-toc-h2', 'marker-toc-h2', 'marker-toc-h3', 'marker-toc-h1'])
})

test('clicking an entry scrolls to its heading', async t => {
	const window = await buildPage(FIXTURE)
	const {document} = window

	let scrolled = null
	for (const heading of document.querySelectorAll('#marker-content h1, #marker-content h2')) {
		heading.scrollIntoView = () => {
			scrolled = heading
		}
	}

	const link = [...document.querySelectorAll('.marker-toc a')]
		.find(a => a.textContent === 'Beta')
	link.dispatchEvent(new window.MouseEvent('click', {bubbles: true, cancelable: true}))

	t.truthy(scrolled)
	t.is(scrolled.tagName, 'H2')
	t.is(scrolled.textContent, 'Beta')
})

test('the sidebar rebuilds after a hot-reload content swap', async t => {
	const window = await buildPage(FIXTURE)
	const {document} = window

	document.querySelector('#marker-content').innerHTML =
		await markdownToHTML('# Only\n\n## New section\n')
	document.dispatchEvent(new window.CustomEvent('marker:reload'))
	await tick(10)

	const navs = document.querySelectorAll('.marker-toc')
	t.is(navs.length, 1)
	t.deepEqual([...navs[0].querySelectorAll('li')].map(item => item.textContent),
		['Only', 'New section'])
})

test('clicking the handle pins the panel and survives rebuilds', async t => {
	const window = await buildPage(FIXTURE)
	const {document} = window

	const nav = document.querySelector('.marker-toc')
	const handle = nav.querySelector('.marker-toc-handle')
	t.false(nav.classList.contains('pinned'))
	t.is(handle.textContent, '≡')

	handle.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	t.true(nav.classList.contains('pinned'))
	t.is(handle.textContent, '✕')
	t.is(window.localStorage.getItem('markserv-marker-toc-pinned'), '1')

	// Rebuild (hot reload) keeps the pinned state
	document.dispatchEvent(new window.CustomEvent('marker:reload'))
	await tick(10)
	t.true(document.querySelector('.marker-toc').classList.contains('pinned'))
})

test('unresolved-comment badges count threads per heading section', async t => {
	// FIXTURE line numbers: First=1, Alpha=5, Beta=9, Deep heading=13, Second=15
	const store = {
		threads: [
			{id: 'abc123-c1', lineStart: 3}, // Section of First
			{id: 'abc123-c2', lineStart: 7}, // Alpha
			{id: 'abc123-c3', lineStart: 7}, // Alpha
			{id: 'abc123-c4', lineStart: 13} // Deep heading
		]
	}
	const window = await buildPage(FIXTURE, store)
	const {document} = window
	await tick(10)

	const badgeOf = label => {
		const item = [...document.querySelectorAll('.marker-toc li')]
			.find(li => li.querySelector('a').textContent === label)
		const badge = item.querySelector('.marker-toc-count')
		return badge ? badge.textContent : null
	}

	t.is(badgeOf('First'), '1')
	t.is(badgeOf('Alpha'), '2')
	t.is(badgeOf('Beta'), null)
	t.is(badgeOf('Deep heading'), '1')
	t.is(badgeOf('Second'), null)

	// A comment change (ws push -> marker:comments) refreshes the badges
	store.threads = [{id: 'abc123-c9', lineStart: 15}]
	document.dispatchEvent(new window.CustomEvent('marker:comments'))
	await tick(10)

	t.is(badgeOf('Alpha'), null)
	t.is(badgeOf('Second'), '1')
})

test('no sidebar for documents with fewer than two headings', async t => {
	const window = await buildPage('# Lonely\n\njust text\n')
	t.falsy(window.document.querySelector('.marker-toc'))
	t.falsy(window.document.querySelector('.marker-toc-zone'))
	t.falsy(window.document.querySelector('.marker-toc-handle'))
})
