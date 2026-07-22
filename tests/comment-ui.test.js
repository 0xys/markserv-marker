'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('ava')
const {JSDOM} = require('jsdom')

const {markdownToHTML} = require('../lib/server')

const COMMENTS_JS = fs.readFileSync(
	path.join(__dirname, '..', 'lib', 'templates', 'comments.js'), 'utf8')

const MARKDOWN = `# Title

This paragraph has some reviewable text in it.

Another paragraph entirely.
`

const tick = ms => new Promise(resolve => {
	setTimeout(resolve, ms)
})

// Builds a jsdom page resembling a rendered registered-file page, with a
// mocked fetch capturing API calls, and runs comments.js in it
const buildPage = async threads => {
	const contentHtml = await markdownToHTML(MARKDOWN)
	const dom = new JSDOM(
		`<!DOCTYPE html><html><body>
			<article class="markdown-body"><div id="marker-content">${contentHtml}</div></article>
			<div class="page-controls"><button class="page-btn" id="theme-toggle"></button></div>
		</body></html>`,
		{url: 'http://localhost:7642/f/abc123/test.md', runScripts: 'outside-only'})

	const {window} = dom
	const calls = []

	window.__marker = {fileId: 'abc123', apiBase: '/api', hotreload: true}
	window.localStorage.setItem('markserv-marker-author', 'tester')
	window.prompt = () => 'tester'
	window.confirm = () => true

	window.fetch = (url, options = {}) => {
		const call = {url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null}
		calls.push(call)

		let data = {}
		if (call.method === 'GET') {
			data = {fileId: 'abc123', threads}
		} else if (call.method === 'POST') {
			data = {id: 'abc123-c99', ...call.body}
		}

		return Promise.resolve({
			ok: true,
			status: call.method === 'DELETE' ? 204 : 200,
			json: () => Promise.resolve(data)
		})
	}

	window.eval(COMMENTS_JS)
	await tick(20) // Let the initial refresh() settle
	return {window, document: window.document, calls}
}

test('thread widgets render and quotes are highlighted', async t => {
	const {document} = await buildPage([{
		id: 'abc123-c1',
		fileId: 'abc123',
		lineStart: 3,
		lineEnd: 3,
		quote: 'some reviewable text',
		parentId: null,
		author: 'reviewer',
		body: 'Please rephrase',
		createdAt: '2026-07-21T00:00:00.000Z',
		resolved: false,
		replies: []
	}])

	const widget = document.querySelector('.marker-thread[data-thread-id="abc123-c1"]')
	t.truthy(widget)
	t.true(widget.textContent.includes('Please rephrase'))
	t.true(widget.textContent.includes('reviewer'))

	const mark = document.querySelector('mark.marker-quote')
	t.truthy(mark)
	t.is(mark.textContent, 'some reviewable text')
	// The highlighted paragraph still reads intact
	const paragraph = mark.closest('p')
	t.is(paragraph.textContent, 'This paragraph has some reviewable text in it.')
})

test('selecting text shows the comment button and posts with quote + lines', async t => {
	const {window, document, calls} = await buildPage([])

	// Select "reviewable text" inside the first paragraph (source line 3)
	const paragraph = document.querySelector('p[data-source-line="3"]')
	t.truthy(paragraph)
	const textNode = paragraph.firstChild
	const range = document.createRange()
	const offset = textNode.nodeValue.indexOf('reviewable')
	range.setStart(textNode, offset)
	range.setEnd(textNode, offset + 'reviewable text'.length)
	const selection = window.getSelection()
	selection.removeAllRanges()
	selection.addRange(range)

	document.dispatchEvent(new window.Event('mouseup', {bubbles: true}))
	await tick(10)

	const button = document.querySelector('.marker-select-btn')
	t.truthy(button)
	t.is(button.style.display, 'block')

	// Click (mousedown) the button -> form appears with a quote preview
	button.dispatchEvent(new window.Event('mousedown', {bubbles: true, cancelable: true}))
	await tick(10)

	const form = document.querySelector('.marker-form')
	t.truthy(form)
	t.is(form.querySelector('.marker-quote-preview').textContent, 'reviewable text')

	// Type and submit
	const textarea = form.querySelector('textarea')
	textarea.value = 'Needs work'
	textarea.dispatchEvent(new window.Event('input', {bubbles: true}))

	const saveButton = form.querySelector('.marker-btn-primary')
	saveButton.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	await tick(20)

	const post = calls.find(call => call.method === 'POST')
	t.truthy(post)
	t.is(post.body.lineStart, 3)
	t.is(post.body.lineEnd, 3)
	t.is(post.body.quote, 'reviewable text')
	t.is(post.body.body, 'Needs work')
	t.is(post.body.author, 'tester')
})

test('reply and resolve controls issue the right API calls', async t => {
	const {window, document, calls} = await buildPage([{
		id: 'abc123-c1',
		fileId: 'abc123',
		lineStart: 3,
		lineEnd: 3,
		quote: null,
		parentId: null,
		author: 'reviewer',
		body: 'Root comment',
		createdAt: '2026-07-21T00:00:00.000Z',
		resolved: false,
		replies: []
	}])

	const widget = document.querySelector('.marker-thread')
	const links = [...widget.querySelectorAll('.marker-link')]
	const replyLink = links.at(-1)
	replyLink.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	await tick(10)

	const textarea = widget.querySelector('textarea')
	t.truthy(textarea)
	textarea.value = 'On it'
	textarea.dispatchEvent(new window.Event('input', {bubbles: true}))
	widget.querySelector('.marker-btn-primary')
		.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	await tick(20)

	const post = calls.find(call => call.method === 'POST')
	t.truthy(post)
	t.is(post.body.parentId, 'abc123-c1')
	t.is(post.body.body, 'On it')

	const resolveButton = widget.querySelector('.marker-thread-head .marker-btn-small')
	resolveButton.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	await tick(20)

	const patch = calls.find(call => call.method === 'PATCH')
	t.truthy(patch)
	t.true(patch.url.endsWith('/api/comments/abc123-c1'))
	t.deepEqual(patch.body, {resolved: true})
})

test('a changed snapshot renders a diff inside the thread', async t => {
	const {document} = await buildPage([{
		id: 'abc123-c1',
		fileId: 'abc123',
		lineStart: 3,
		lineEnd: 4,
		quote: null,
		snapshot: {lineStart: 3, lineEnd: 4, text: 'old first line\nshared line'},
		currentText: 'new first line\nshared line',
		changed: true,
		parentId: null,
		author: 'reviewer',
		body: 'About these lines',
		createdAt: '2026-07-21T00:00:00.000Z',
		resolved: false,
		replies: []
	}])

	const widget = document.querySelector('.marker-thread')
	t.truthy(widget.querySelector('.marker-changed-badge'))

	// Side-by-side: first row pairs the changed lines, second row is context
	const rows = [...widget.querySelectorAll('.marker-diff-table tr')]
	t.is(rows.length, 2)

	const [oldCell, newCell] = rows[0].querySelectorAll('td')
	t.true(oldCell.classList.contains('del'))
	t.is(oldCell.textContent, 'old first line')
	t.true(newCell.classList.contains('add'))
	t.is(newCell.textContent, 'new first line')

	// Only the characters that actually differ get the strong highlight
	t.deepEqual([...oldCell.querySelectorAll('.chg')].map(s => s.textContent), ['old'])
	t.deepEqual([...newCell.querySelectorAll('.chg')].map(s => s.textContent), ['new'])

	const contextCells = [...rows[1].querySelectorAll('td')]
	t.true(contextCells.every(cell => cell.classList.contains('ctx')))
	t.deepEqual(contextCells.map(cell => cell.textContent), ['shared line', 'shared line'])
})

test('a deleted line leaves an empty cell on the right', async t => {
	const {document} = await buildPage([{
		id: 'abc123-c1',
		fileId: 'abc123',
		lineStart: 3,
		lineEnd: 4,
		quote: null,
		snapshot: {lineStart: 3, lineEnd: 4, text: 'kept line\ndoomed line'},
		currentText: 'kept line',
		changed: true,
		parentId: null,
		author: 'reviewer',
		body: 'That second line mattered',
		createdAt: '2026-07-21T00:00:00.000Z',
		resolved: false,
		replies: []
	}])

	const rows = [...document.querySelectorAll('.marker-diff-table tr')]
	t.is(rows.length, 2)
	const [oldCell, newCell] = rows[1].querySelectorAll('td')
	t.true(oldCell.classList.contains('del'))
	t.is(oldCell.textContent, 'doomed line')
	t.true(newCell.classList.contains('empty'))
	t.is(newCell.textContent, '')
})

test('an unchanged snapshot renders no diff', async t => {
	const {document} = await buildPage([{
		id: 'abc123-c1',
		fileId: 'abc123',
		lineStart: 3,
		lineEnd: 3,
		quote: null,
		snapshot: {lineStart: 3, lineEnd: 3, text: 'same'},
		currentText: 'same',
		changed: false,
		parentId: null,
		author: 'reviewer',
		body: 'No drama here',
		createdAt: '2026-07-21T00:00:00.000Z',
		resolved: false,
		replies: []
	}])

	const widget = document.querySelector('.marker-thread')
	t.falsy(widget.querySelector('.marker-diff'))
	t.falsy(widget.querySelector('.marker-changed-badge'))
})

test('threads collapse and expand from the header, surviving refreshes', async t => {
	const {window, document} = await buildPage([{
		id: 'abc123-c1',
		fileId: 'abc123',
		lineStart: 3,
		lineEnd: 3,
		quote: null,
		parentId: null,
		author: 'reviewer',
		body: 'Collapsible',
		createdAt: '2026-07-21T00:00:00.000Z',
		resolved: false,
		replies: []
	}])

	let widget = document.querySelector('.marker-thread')
	// Unresolved threads start expanded
	t.false(widget.classList.contains('collapsed'))
	t.is(widget.querySelector('.marker-chevron').textContent, '▾')

	const head = widget.querySelector('.marker-thread-head')
	head.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	t.true(widget.classList.contains('collapsed'))
	t.is(widget.querySelector('.marker-chevron').textContent, '▸')

	// The user's collapse choice survives a rebuild (e.g. new comment pushed)
	document.dispatchEvent(new window.CustomEvent('marker:comments'))
	await tick(20)
	widget = document.querySelector('.marker-thread')
	t.true(widget.classList.contains('collapsed'))

	widget.querySelector('.marker-thread-head')
		.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	t.false(widget.classList.contains('collapsed'))
})

test('the view button cycles all / unresolved / mark / plain', async t => {
	const mkThread = (id, line, quote, resolved) => ({
		id, fileId: 'abc123', lineStart: line, lineEnd: line, quote, parentId: null,
		author: 'reviewer', body: 'b', createdAt: '2026-07-21T00:00:00.000Z', resolved, replies: []
	})
	const {window, document} = await buildPage([
		mkThread('abc123-c1', 3, 'reviewable text', false),
		mkThread('abc123-c2', 5, 'Another paragraph', true)
	])

	const btn = document.querySelector('#marker-view-toggle')
	t.truthy(btn)
	t.is(btn.querySelector('.marker-view-label').textContent, 'all')
	t.is(document.querySelectorAll('.marker-thread').length, 2)
	t.is(document.querySelectorAll('mark.marker-quote').length, 2)

	// Unresolved: resolved thread and its highlight disappear
	btn.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	t.is(btn.querySelector('.marker-view-label').textContent, 'unresolved')
	const open = [...document.querySelectorAll('.marker-thread')]
	t.is(open.length, 1)
	t.is(open[0].dataset.threadId, 'abc123-c1')
	t.is(document.querySelectorAll('mark.marker-quote').length, 1)

	// Mark: highlights only, no widgets; clicking a mark opens its thread
	btn.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	t.is(btn.querySelector('.marker-view-label').textContent, 'mark')
	t.is(document.querySelectorAll('.marker-thread').length, 0)
	t.is(document.querySelectorAll('mark.marker-quote').length, 2)

	const mark = document.querySelector('mark.marker-quote[data-thread-id="abc123-c1"]')
	mark.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	const revealed = [...document.querySelectorAll('.marker-thread')]
	t.is(revealed.length, 1)
	t.is(revealed[0].dataset.threadId, 'abc123-c1')

	// Clicking the mark again hides the thread
	document.querySelector('mark.marker-quote[data-thread-id="abc123-c1"]')
		.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	t.is(document.querySelectorAll('.marker-thread').length, 0)

	// Plain: nothing at all
	btn.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	t.is(btn.querySelector('.marker-view-label').textContent, 'plain')
	t.is(document.querySelectorAll('.marker-thread').length, 0)
	t.is(document.querySelectorAll('mark.marker-quote').length, 0)

	// Back to all
	btn.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	t.is(btn.querySelector('.marker-view-label').textContent, 'all')
	t.is(document.querySelectorAll('.marker-thread').length, 2)
})

test('same-block comments render in ascending line order', async t => {
	const mkThread = (id, line) => ({
		id, fileId: 'abc123', lineStart: line, lineEnd: line, quote: null, parentId: null,
		author: 'reviewer', body: 'L' + line, createdAt: '2026-07-21T00:00:00.000Z',
		resolved: false, replies: []
	})
	// Lines 3 and 4 both anchor to the paragraph on line 3 (fallback anchor);
	// the API returns threads sorted by line, mimic that order here
	const {document} = await buildPage([mkThread('abc123-c1', 3), mkThread('abc123-c2', 4)])

	const ids = [...document.querySelectorAll('.marker-thread')]
		.map(w => w.dataset.threadId)
	t.deepEqual(ids, ['abc123-c1', 'abc123-c2'])
})

test('hot reload rebuilds widgets after content swap', async t => {
	const {window, document} = await buildPage([{
		id: 'abc123-c1',
		fileId: 'abc123',
		lineStart: 3,
		lineEnd: 3,
		quote: 'some reviewable text',
		parentId: null,
		author: 'reviewer',
		body: 'Persistent thread',
		createdAt: '2026-07-21T00:00:00.000Z',
		resolved: false,
		replies: []
	}])

	// Simulate what the hotreload script does: replace content, fire event
	const newHtml = await markdownToHTML(MARKDOWN)
	document.querySelector('#marker-content').innerHTML = newHtml
	t.falsy(document.querySelector('.marker-thread'))

	document.dispatchEvent(new window.CustomEvent('marker:reload'))
	await tick(20)

	t.truthy(document.querySelector('.marker-thread'))
	t.truthy(document.querySelector('mark.marker-quote'))
})
