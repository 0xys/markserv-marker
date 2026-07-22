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

const buildPage = async markdown => {
	const contentHtml = await markdownToHTML(markdown)
	const dom = new JSDOM(
		`<!DOCTYPE html><html><body>
			<article class="markdown-body"><div id="marker-content">${contentHtml}</div></article>
		</body></html>`,
		{url: 'http://localhost:7642/f/abc123/test.md', runScripts: 'outside-only'})

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

test('the sidebar lists h1 and h2 in document order, h3 excluded', async t => {
	const window = await buildPage(FIXTURE)
	const {document} = window

	const nav = document.querySelector('.marker-toc')
	t.truthy(nav)
	t.true(document.body.classList.contains('has-toc'))

	const items = [...nav.querySelectorAll('li')]
	t.deepEqual(items.map(item => item.textContent), ['First', 'Alpha', 'Beta', 'Second'])
	t.deepEqual(items.map(item => item.className),
		['marker-toc-h1', 'marker-toc-h2', 'marker-toc-h2', 'marker-toc-h1'])
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

test('no sidebar for documents with fewer than two headings', async t => {
	const window = await buildPage('# Lonely\n\njust text\n')
	t.falsy(window.document.querySelector('.marker-toc'))
	t.false(window.document.body.classList.contains('has-toc'))
})
