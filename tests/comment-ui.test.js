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
const buildPage = async (threads, markdown = MARKDOWN) => {
	const contentHtml = await markdownToHTML(markdown)
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

test('shift+enter posts the draft, plain enter and IME enter do not', async t => {
	const {window, document, calls} = await buildPage([])

	const paragraph = document.querySelector('p[data-source-line="3"]')
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
	document.querySelector('.marker-select-btn')
		.dispatchEvent(new window.Event('mousedown', {bubbles: true, cancelable: true}))
	await tick(10)

	// The shortcut is spelled out next to the buttons
	t.is(document.querySelector('.marker-form .marker-form-hint').textContent,
		'Shift+Enter to post')

	const textarea = document.querySelector('.marker-form textarea')
	textarea.value = 'Keyboard only'
	textarea.dispatchEvent(new window.Event('input', {bubbles: true}))

	const press = init => {
		const event = new window.KeyboardEvent('keydown', {
			key: 'Enter', bubbles: true, cancelable: true, ...init
		})
		textarea.dispatchEvent(event)
		return event
	}

	// Plain Enter stays a newline: not consumed, nothing posted
	const plain = press({})
	await tick(20)
	t.false(plain.defaultPrevented)
	t.falsy(calls.find(call => call.method === 'POST'))

	// Enter that commits an IME conversion candidate must not post either
	press({shiftKey: true, isComposing: true})
	await tick(20)
	t.falsy(calls.find(call => call.method === 'POST'))

	const shift = press({shiftKey: true})
	await tick(20)
	t.true(shift.defaultPrevented)

	const post = calls.find(call => call.method === 'POST')
	t.truthy(post)
	t.is(post.body.body, 'Keyboard only')
	t.is(post.body.quote, 'reviewable text')
	t.is(post.body.author, 'tester')
})

// How many times `needle` appears before the first quote highlight
const occurrenceOfMark = (window, needle) => {
	const {document} = window
	const mark = document.querySelector('mark.marker-quote')
	if (!mark) {
		return null
	}

	const range = document.createRange()
	range.setStart(document.querySelector('#marker-content'), 0)
	range.setEndBefore(mark)
	return range.toString().split(needle).length // 1-based occurrence number
}

// Selects `needle`'s nth (0-based) occurrence inside the given paragraph
const selectOccurrence = (window, paragraph, needle, nth) => {
	const textNode = paragraph.firstChild
	let offset = -1
	for (let i = 0; i <= nth; i++) {
		offset = textNode.nodeValue.indexOf(needle, offset + 1)
	}

	const range = window.document.createRange()
	range.setStart(textNode, offset)
	range.setEnd(textNode, offset + needle.length)
	const selection = window.getSelection()
	selection.removeAllRanges()
	selection.addRange(range)
	window.document.dispatchEvent(new window.Event('mouseup', {bubbles: true}))
}

// "text" twice in one paragraph, and once more in a later one
const REPEATED = '# T\n\nkeep the text and also drop the text here.\n\nunrelated text.\n'

const postQuoteIndex = async nth => {
	const {window, document, calls} = await buildPage([], REPEATED)
	selectOccurrence(window, document.querySelector('p[data-source-line="3"]'), 'text', nth)
	await tick(10)
	document.querySelector('.marker-select-btn')
		.dispatchEvent(new window.Event('mousedown', {bubbles: true, cancelable: true}))
	await tick(10)

	const textarea = document.querySelector('.marker-form textarea')
	textarea.value = 'this one'
	textarea.dispatchEvent(new window.Event('input', {bubbles: true}))
	document.querySelector('.marker-form .marker-btn-primary')
		.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	await tick(20)
	return calls.find(call => call.method === 'POST').body
}

test('the selected occurrence of a repeated word is posted as quoteIndex', async t => {
	const first = await postQuoteIndex(0)
	t.is(first.quote, 'text')
	t.is(first.quoteIndex, 0)

	// The second "text" in the same paragraph must not report as the first
	const second = await postQuoteIndex(1)
	t.is(second.quote, 'text')
	t.is(second.quoteIndex, 1)
})

test('quoteIndex highlights the selected identical word, not always the first', async t => {
	const withIndex = async quoteIndex => {
		const {window} = await buildPage([{
			id: 'abc123-c1', fileId: 'abc123', lineStart: 3, lineEnd: 3,
			quote: 'text', quoteIndex, parentId: null, author: 'reviewer',
			body: 'this one', createdAt: '2026-07-21T00:00:00.000Z', resolved: false, replies: []
		}], REPEATED)
		return occurrenceOfMark(window, 'text')
	}

	t.is(await withIndex(0), 1)
	t.is(await withIndex(1), 2)
	// Out of range clamps to the last one in the block rather than losing the mark
	t.is(await withIndex(9), 2)
	// Missing quoteIndex (comments written before this existed) behaves as 0
	t.is(await withIndex(undefined), 1)
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

// Deleting is offered on each comment too, but only inside the body, which a
// collapsed thread hides — and a thread one wants rid of is usually collapsed.
test('a thread can be deleted from its head while collapsed', async t => {
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
		resolved: true,
		replies: [{
			id: 'abc123-c2',
			fileId: 'abc123',
			parentId: 'abc123-c1',
			author: 'claude',
			body: 'Done',
			createdAt: '2026-07-21T01:00:00.000Z',
			resolved: false
		}]
	}])

	const widget = document.querySelector('.marker-thread')
	// Resolved threads start collapsed, which is the state under test
	t.true(widget.classList.contains('collapsed'))

	const button = widget.querySelector('.marker-thread-delete')
	t.truthy(button)
	// In the head, so hiding the body does not hide it
	t.is(button.parentElement.className, 'marker-thread-head')
	t.falsy(button.closest('.marker-thread-body'))
	// It says what goes with it
	t.is(button.title, 'Delete this comment and its 1 reply')

	button.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	await tick(20)

	const removed = calls.find(call => call.method === 'DELETE')
	t.truthy(removed)
	t.true(removed.url.endsWith('/api/comments/abc123-c1'))
	// The click must not reach the head underneath and expand the thread
	t.true(document.querySelector('.marker-thread').classList.contains('collapsed'))
})

test('declining the confirmation deletes nothing', async t => {
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

	window.confirm = () => false
	const button = document.querySelector('.marker-thread-delete')
	t.is(button.title, 'Delete this comment')
	button.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	await tick(20)

	t.falsy(calls.find(call => call.method === 'DELETE'))
})

test('the widget sits by the re-anchored line, not where it was written', async t => {
	// Two paragraphs were inserted above the commented one, so the API reports
	// line 7 while the comment was originally written against line 5
	const contentHtml = await markdownToHTML(
		'# Doc\n\nintro paragraph.\n\nbrand new paragraph.\n\nthe commented paragraph.\n')
	const dom = new JSDOM(
		`<!DOCTYPE html><html><body>
			<article class="markdown-body"><div id="marker-content">${contentHtml}</div></article>
			<div class="page-controls"></div>
		</body></html>`,
		{url: 'http://localhost:7642/f/abc123/test.md', runScripts: 'outside-only'})
	const {window} = dom
	window.__marker = {fileId: 'abc123', apiBase: '/api', hotreload: true}
	window.localStorage.setItem('markserv-marker-author', 'tester')
	window.fetch = () => Promise.resolve({
		ok: true, status: 200,
		json: () => Promise.resolve({
			fileId: 'abc123',
			threads: [{
				id: 'abc123-c1', fileId: 'abc123', lineStart: 7, lineEnd: 7,
				quote: 'the commented paragraph.',
				snapshot: {lineStart: 5, lineEnd: 5, text: 'the commented paragraph.'},
				currentText: 'the commented paragraph.', changed: false,
				parentId: null, author: 'reviewer', body: 'Still about this line',
				createdAt: '2026-07-21T00:00:00.000Z', resolved: false, replies: []
			}]
		})
	})
	window.eval(COMMENTS_JS)
	await tick(20)

	const {document} = window
	const widget = document.querySelector('.marker-thread')
	t.truthy(widget)
	// The widget and its highlight both land on the paragraph the text is in now
	t.is(widget.previousElementSibling.dataset.sourceLine, '7')
	const mark = document.querySelector('mark.marker-quote')
	t.is(mark.closest('[data-source-line]').dataset.sourceLine, '7')
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

test('a repeated short quote highlights the occurrence in the commented lines', async t => {
	// "word" appears on line 3 and again in a table header on line 7;
	// the comment anchors to line 7, so the table occurrence must win
	const markdown = 'word intro here\n\ntext with word inside\n\n# Section\n\n| word | other |\n|---|---|\n| a | b |\n'
	const contentHtml = await markdownToHTML(markdown)
	const dom = new JSDOM(
		`<!DOCTYPE html><html><body>
			<article class="markdown-body"><div id="marker-content">${contentHtml}</div></article>
			<div class="page-controls"></div>
		</body></html>`,
		{url: 'http://localhost:7642/f/abc123/test.md', runScripts: 'outside-only'})
	const {window} = dom
	window.__marker = {fileId: 'abc123', apiBase: '/api', hotreload: true}
	window.localStorage.setItem('markserv-marker-author', 'tester')
	window.fetch = () => Promise.resolve({
		ok: true, status: 200,
		json: () => Promise.resolve({
			fileId: 'abc123', threads: [{
				id: 'abc123-c1', fileId: 'abc123', lineStart: 7, lineEnd: 7, quote: 'word',
				parentId: null, author: 'reviewer', body: 'On the table header',
				createdAt: '2026-07-21T00:00:00.000Z', resolved: false, replies: []
			}]
		})
	})
	window.eval(COMMENTS_JS)
	await tick(20)

	const mark = window.document.querySelector('mark.marker-quote')
	t.truthy(mark)
	const block = mark.closest('[data-source-line]')
	t.is(block.tagName, 'TH')
	t.is(block.dataset.sourceLine, '7')
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

/* ---------- mermaid blocks ---------- */

// lib/mermaid.js wraps a mermaid fence so the browser can put a diagram beside
// its source. Comments are made on the source, which must behave like any
// other fence, and the widgets must not end up inside that wrapper.
const MERMAID_MARKDOWN = `# Title

\`\`\`mermaid
graph TD;
  Draft-->Review;
\`\`\`

Closing paragraph.
`

const mermaidThread = (id, line, quote) => ({
	id,
	fileId: 'abc123',
	lineStart: line,
	lineEnd: line,
	quote,
	parentId: null,
	author: 'reviewer',
	body: 'On ' + (quote || 'L' + line),
	createdAt: '2026-07-21T00:00:00.000Z',
	resolved: false,
	replies: []
})

test('a thread on a mermaid block sits after the whole block, not inside it', async t => {
	const {document} = await buildPage(
		[mermaidThread('abc123-c1', 4, 'Draft-->Review')], MERMAID_MARKDOWN)

	const wrapper = document.querySelector('.marker-mermaid')
	const widget = document.querySelector('.marker-thread')
	t.truthy(widget)
	// Inside the wrapper the widget would be buried among the diagram controls
	t.is(widget.parentElement.id, 'marker-content')
	t.is(wrapper.nextElementSibling, widget)

	// The quote is highlighted in the source, where it can be read and clicked
	const mark = document.querySelector('mark.marker-quote')
	t.truthy(mark)
	t.truthy(mark.closest('pre.marker-mermaid-source code.language-mermaid'))
})

test('several threads on one mermaid block stay in line order after it', async t => {
	const {document} = await buildPage(
		[mermaidThread('abc123-c1', 3), mermaidThread('abc123-c2', 4)], MERMAID_MARKDOWN)

	const widgets = [...document.querySelectorAll('.marker-thread')]
	t.deepEqual(widgets.map(w => w.dataset.threadId), ['abc123-c1', 'abc123-c2'])
	const wrapper = document.querySelector('.marker-mermaid')
	t.is(wrapper.nextElementSibling, widgets[0])
	t.is(widgets[0].nextElementSibling, widgets[1])
})

test('selecting mermaid source posts the fence line range', async t => {
	const {window, document, calls} = await buildPage([], MERMAID_MARKDOWN)

	const code = document.querySelector('pre.marker-mermaid-source code')
	const textNode = code.firstChild
	const offset = textNode.nodeValue.indexOf('Draft')
	const range = document.createRange()
	range.setStart(textNode, offset)
	range.setEnd(textNode, offset + 'Draft-->Review'.length)
	const selection = window.getSelection()
	selection.removeAllRanges()
	selection.addRange(range)

	document.dispatchEvent(new window.Event('mouseup', {bubbles: true}))
	await tick(10)
	document.querySelector('.marker-select-btn')
		.dispatchEvent(new window.Event('mousedown', {bubbles: true, cancelable: true}))
	await tick(10)

	const form = document.querySelector('.marker-form')
	t.truthy(form)
	form.querySelector('textarea').value = 'Reverse this arrow'
	form.querySelector('textarea').dispatchEvent(new window.Event('input', {bubbles: true}))
	form.querySelector('.marker-btn-primary')
		.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	await tick(20)

	const post = calls.find(call => call.method === 'POST')
	t.truthy(post)
	t.is(post.body.lineStart, 3)
	t.is(post.body.lineEnd, 6)
	t.is(post.body.quote, 'Draft-->Review')
})

test('text inside a rendered diagram is kept out of quote matching', async t => {
	const {window, document} = await buildPage(
		[mermaidThread('abc123-c1', 4, 'Review')], MERMAID_MARKDOWN)

	// What lib/templates/mermaid.js adds: a diagram whose labels repeat the
	// words of the source. Unmarked it would shift occurrence counting for the
	// whole document, so mermaid.js marks it as UI.
	const diagram = document.createElement('div')
	diagram.className = 'marker-mermaid-diagram'
	diagram.dataset.markerUi = ''
	diagram.innerHTML = '<svg><text>Draft</text><text>Review</text></svg>'
	document.querySelector('.marker-mermaid').append(diagram)

	document.dispatchEvent(new window.CustomEvent('marker:comments'))
	await tick(20)

	const marks = [...document.querySelectorAll('mark.marker-quote')]
	t.is(marks.length, 1)
	t.truthy(marks[0].closest('pre.marker-mermaid-source'))
})

test('marker:rendered fires once widgets and highlights are in place', async t => {
	const {window, document} = await buildPage(
		[mermaidThread('abc123-c1', 4, 'Review')], MERMAID_MARKDOWN)

	const seen = []
	document.addEventListener('marker:rendered', () => {
		seen.push({
			widgets: document.querySelectorAll('.marker-thread').length,
			marks: document.querySelectorAll('mark.marker-quote').length
		})
	})

	document.dispatchEvent(new window.CustomEvent('marker:comments'))
	await tick(20)

	t.deepEqual(seen, [{widgets: 1, marks: 1}])
})

/* ---------- auto-linkified URLs ---------- */

// Bare URLs are linkified now, which splits a paragraph's single text node
// into text / <a>text</a> / text. Quote matching concatenates node values, so
// the anchoring must be unaffected — and a highlight can end up inside the
// anchor, where the click belongs to the thread and not to the link.
const URL_MARKDOWN = `# Title

詳細は https://example.com/docs を見てください。

Another paragraph entirely.
`

test('a comment anchors normally around an auto-linkified URL', async t => {
	const {document} = await buildPage([{
		id: 'abc123-c1',
		fileId: 'abc123',
		lineStart: 3,
		lineEnd: 3,
		quote: '詳細は',
		parentId: null,
		author: 'reviewer',
		body: 'ここを直して',
		createdAt: '2026-07-21T00:00:00.000Z',
		resolved: false,
		replies: []
	}], URL_MARKDOWN)

	// The paragraph really did get a link
	const paragraph = document.querySelector('p[data-source-line="3"]')
	t.truthy(paragraph.querySelector('a[href="https://example.com/docs"]'))

	const marks = [...document.querySelectorAll('mark.marker-quote')]
	t.is(marks.length, 1)
	t.is(marks[0].textContent, '詳細は')
	t.truthy(document.querySelector('.marker-thread[data-thread-id="abc123-c1"]'))

	// The link text is still part of the paragraph's text, unsplit
	t.is(paragraph.textContent, '詳細は https://example.com/docs を見てください。')
})

test('clicking a highlight inside a link opens the thread instead of navigating', async t => {
	const {window, document} = await buildPage([{
		id: 'abc123-c1',
		fileId: 'abc123',
		lineStart: 3,
		lineEnd: 3,
		quote: 'https://example.com/docs',
		parentId: null,
		author: 'reviewer',
		body: 'このURLは古い',
		createdAt: '2026-07-21T00:00:00.000Z',
		resolved: false,
		replies: []
	}], URL_MARKDOWN)

	const mark = document.querySelector('mark.marker-quote')
	t.truthy(mark)
	// The highlight landed inside the anchor, which is what makes the guard needed
	t.truthy(mark.closest('a'))

	const widget = document.querySelector('.marker-thread[data-thread-id="abc123-c1"]')
	widget.classList.add('collapsed')

	const event = new window.MouseEvent('click', {bubbles: true, cancelable: true})
	mark.dispatchEvent(event)
	await tick(10)

	// Cancelled, so the browser would not follow the href
	t.true(event.defaultPrevented)
	t.false(widget.classList.contains('collapsed'))
})

test('a highlight outside any link still does not cancel the click', async t => {
	const {window, document} = await buildPage([{
		id: 'abc123-c1',
		fileId: 'abc123',
		lineStart: 5,
		lineEnd: 5,
		quote: 'Another paragraph',
		parentId: null,
		author: 'reviewer',
		body: 'plain text quote',
		createdAt: '2026-07-21T00:00:00.000Z',
		resolved: false,
		replies: []
	}], URL_MARKDOWN)

	const mark = document.querySelector('mark.marker-quote')
	t.falsy(mark.closest('a'))
	const event = new window.MouseEvent('click', {bubbles: true, cancelable: true})
	mark.dispatchEvent(event)
	await tick(10)
	t.false(event.defaultPrevented)
})

/* ---------- markdown HTML comments ---------- */

const MD_COMMENTS_JS = fs.readFileSync(
	path.join(__dirname, '..', 'lib', 'templates', 'md-comments.js'), 'utf8')

// "text" twice with an HTML comment between them whose note repeats the very
// word being quoted. The visible note md-comments.js inserts is a real,
// selectable text node marked data-marker-ui — unmarked, it would join the
// quote corpus and quoteIndex 1 would land on the note instead.
const COMMENTED = '# T\n\nkeep the text <!-- a text note --> and also drop the text here.\n'

test('a decorated markdown comment does not shift quoteIndex counting', async t => {
	const {window, document} = await buildPage([{
		id: 'abc123-c1', fileId: 'abc123', lineStart: 3, lineEnd: 3,
		quote: 'text', quoteIndex: 1, parentId: null, author: 'reviewer',
		body: 'this one', createdAt: '2026-07-21T00:00:00.000Z', resolved: false, replies: []
	}], COMMENTED)

	window.eval(MD_COMMENTS_JS)
	await tick(10)
	t.is(document.querySelector('.marker-md-comment').textContent, ' a text note ')

	document.dispatchEvent(new window.CustomEvent('marker:comments'))
	await tick(20)

	// Occurrence 1 over the corpus (which skips the note) is the last "text"
	const mark = document.querySelector('mark.marker-quote')
	t.truthy(mark)
	t.falsy(mark.closest('.marker-md-comment'))
	t.true(mark.nextSibling.nodeValue.startsWith(' here.'))
})
