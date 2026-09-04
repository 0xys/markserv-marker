'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('ava')
const {JSDOM} = require('jsdom')

const {markdownToHTML} = require('../lib/server')

const COMMENTS_JS = fs.readFileSync(
	path.join(__dirname, '..', 'lib', 'templates', 'comments.js'), 'utf8')
const DIFF_CORE_JS = fs.readFileSync(
	path.join(__dirname, '..', 'lib', 'templates', 'diff-core.js'), 'utf8')

// Eight lines, so a selection in the middle has three of context either way
const SOURCE = `# Title

first paragraph

second paragraph

third paragraph
`

const tick = ms => new Promise(resolve => {
	setTimeout(resolve, ms)
})

// The page plus a fake file behind it: the editor reads through
// GET /content and writes through PATCH /content, so the mock keeps a
// document of its own and answers from it.
const buildPage = async ({content = SOURCE, patch = null} = {}) => {
	const contentHtml = await markdownToHTML(content)
	const dom = new JSDOM(
		`<!DOCTYPE html><html><body>
			<article class="markdown-body"><div id="marker-content">${contentHtml}</div></article>
			<div class="page-controls"><button class="page-btn" id="theme-toggle"></button></div>
		</body></html>`,
		{url: 'http://localhost:7642/f/abc123/test.md', runScripts: 'outside-only'})

	const {window} = dom
	const calls = []
	const file = {content}

	window.__marker = {fileId: 'abc123', apiBase: '/api', hotreload: true}
	window.localStorage.setItem('markserv-marker-author', 'tester')
	window.alert = message => calls.push({alert: message})

	window.fetch = (url, options = {}) => {
		const call = {
			url,
			method: options.method || 'GET',
			body: options.body ? JSON.parse(options.body) : null
		}
		calls.push(call)

		if (call.method === 'GET' && url.endsWith('/content')) {
			return Promise.resolve({
				ok: true, status: 200,
				json: () => Promise.resolve({content: file.content, lines: file.content.split('\n').length})
			})
		}

		if (call.method === 'PATCH') {
			const answer = patch ? patch(call.body, file) : null
			if (answer && answer.status === 409) {
				return Promise.resolve({
					ok: false, status: 409,
					json: () => Promise.resolve(answer.data)
				})
			}

			const lines = file.content.split('\n')
			const replacement = call.body.text.split('\n')
			file.content = [
				...lines.slice(0, call.body.lineStart - 1),
				...replacement,
				...lines.slice(call.body.lineEnd)
			].join('\n')
			return Promise.resolve({
				ok: true, status: 200,
				json: () => Promise.resolve({
					lineStart: call.body.lineStart,
					lineEnd: call.body.lineStart + replacement.length - 1
				})
			})
		}

		return Promise.resolve({
			ok: true, status: 200,
			json: () => Promise.resolve({fileId: 'abc123', threads: []})
		})
	}

	window.eval(DIFF_CORE_JS)
	window.eval(COMMENTS_JS)
	await tick(20)
	return {
		window, document: window.document, calls, file
	}
}

// Selects text in the paragraph on the given source line and raises the bar
const selectLine = async ({window, document}, line) => {
	const paragraph = document.querySelector(`p[data-source-line="${line}"]`)
	const textNode = paragraph.firstChild
	const range = document.createRange()
	range.setStart(textNode, 0)
	range.setEnd(textNode, textNode.nodeValue.length)
	const selection = window.getSelection()
	selection.removeAllRanges()
	selection.addRange(range)
	document.dispatchEvent(new window.Event('mouseup', {bubbles: true}))
	await tick(10)
}

const pressEdit = async ({window, document}) => {
	document.querySelector('.marker-select-edit')
		.dispatchEvent(new window.Event('mousedown', {bubbles: true, cancelable: true}))
	await tick(30)
}

test('the bar offers Edit beside Comment, badged with the wider range', async t => {
	const page = await buildPage()
	await selectLine(page, 5)

	const edit = page.document.querySelector('.marker-select-edit')
	t.truthy(edit)
	t.true(edit.textContent.includes('Edit'))
	// The line selected, not the wider window the editor opens around it
	t.is(edit.querySelector('.marker-select-lines').textContent, 'L5')
	// The comment button carries no badge at all
	t.falsy(page.document.querySelector('.marker-select-btn:not(.marker-select-edit) .marker-select-lines'))
})

// A table row is the one anchor an editor may not use. Its textarea holds
// source lines and does not wrap them for the purpose of intrinsic width, so
// a cell holding one contributes a whole markdown table row to the width its
// table is laid out from.
const TABLE_SOURCE = `# Title

before

| # | label |
|---|---|
| 1 | one |
| 2 | two |

after
`

const selectAcrossRows = async page => {
	const from = page.document.querySelector('tr[data-source-line="7"] td')
	const to = page.document.querySelector('tr[data-source-line="8"] td:last-child')
	const range = page.document.createRange()
	range.setStart(from.firstChild, 0)
	range.setEnd(to.firstChild, to.firstChild.nodeValue.length)
	const selection = page.window.getSelection()
	selection.removeAllRanges()
	selection.addRange(range)
	page.document.dispatchEvent(new page.window.Event('mouseup', {bubbles: true}))
	await tick(10)
}

test('marking a selection that crosses rows adds no cells to the table', async t => {
	const page = await buildPage({content: TABLE_SOURCE})
	// The table's own cells, not the one the editor rides in
	const ownCells = () => [...page.document.querySelectorAll('#marker-content table td')]
		.filter(cell => !cell.closest('[data-marker-ui]')).length
	const cellsBefore = ownCells()
	await selectAcrossRows(page)
	await pressEdit(page)

	// The nodes between cells belong to the row, and a mark put there is
	// laid out as a cell of its own
	t.is(page.document.querySelectorAll('#marker-content tr > mark').length, 0)
	t.is(page.document.querySelectorAll('#marker-content tbody > mark').length, 0)
	t.is(ownCells(), cellsBefore)
	// The text inside the cells is still marked
	t.true(page.document.querySelectorAll('#marker-content td mark.marker-pending').length > 0)
})

const selectCell = async (page, line) => {
	const cell = page.document.querySelector(`tr[data-source-line="${line}"] td`)
	const range = page.document.createRange()
	range.setStart(cell.firstChild, 0)
	range.setEnd(cell.firstChild, cell.firstChild.nodeValue.length)
	const selection = page.window.getSelection()
	selection.removeAllRanges()
	selection.addRange(range)
	page.document.dispatchEvent(new page.window.Event('mouseup', {bubbles: true}))
	await tick(10)
}

test('an editor on a table row rides in a row of its own, sized to the table', async t => {
	const page = await buildPage({content: TABLE_SOURCE})
	const row = page.document.querySelector('tr[data-source-line="7"]')
	// Jsdom lays nothing out, and the width is measured rather than assumed
	Object.defineProperty(page.document.querySelector('#marker-content table'),
		'clientWidth', {value: 420, configurable: true})

	await selectCell(page, 7)
	await pressEdit(page)

	const panel = page.document.querySelector('.marker-editor')
	const host = panel.closest('tr.marker-thread-row')
	t.truthy(host)
	t.is(host.previousElementSibling, row)
	t.is(host.querySelector('td').getAttribute('colspan'), String(row.children.length))
	// Left to itself the cell would ask the table for the width of the widest
	// source line and the columns would be redistributed around it
	t.is(panel.style.width, '420px')
})

test('the pinned width follows the window', async t => {
	const page = await buildPage({content: TABLE_SOURCE})
	const table = page.document.querySelector('#marker-content table')
	Object.defineProperty(table, 'clientWidth', {value: 420, configurable: true})
	await selectCell(page, 7)
	await pressEdit(page)

	Object.defineProperty(table, 'clientWidth', {value: 260, configurable: true})
	page.window.dispatchEvent(new page.window.Event('resize'))
	await tick(10)
	t.is(page.document.querySelector('.marker-editor').style.width, '260px')
})

test('a comment on that same row still rides inside it', async t => {
	const page = await buildPage({content: TABLE_SOURCE})
	await selectCell(page, 7)
	page.document.querySelector('.marker-select-btn:not(.marker-select-edit)')
		.dispatchEvent(new page.window.Event('mousedown', {bubbles: true, cancelable: true}))
	await tick(30)

	const form = page.document.querySelector('.marker-form')
	t.truthy(form)
	t.is(form.closest('tr').previousElementSibling,
		page.document.querySelector('tr[data-source-line="7"]'))
})

test('pressing Edit opens a panel holding those lines of the file', async t => {
	const page = await buildPage()
	await selectLine(page, 5)
	await pressEdit(page)

	const panel = page.document.querySelector('.marker-editor')
	t.truthy(panel)
	t.is(panel.dataset.markerUi, '')
	t.is(panel.querySelector('.marker-lines').textContent, 'L2-8')

	// Exactly lines 2..8 of the source, context included and editable
	const textarea = panel.querySelector('textarea')
	t.is(textarea.value, SOURCE.split('\n').slice(1, 8).join('\n'))

	// It read the file rather than scraping the rendered page
	t.truthy(page.calls.find(call => call.method === 'GET' && call.url.endsWith('/content')))
})

// Focus moving into the textarea takes the browser's own highlight with it,
// leaving the reader writing about text they can no longer see marked
test('the selection stays marked while the editor is open', async t => {
	const page = await buildPage()
	await selectLine(page, 5)
	t.falsy(page.document.querySelector('mark.marker-pending'))

	await pressEdit(page)

	const marks = [...page.document.querySelectorAll('mark.marker-pending')]
	t.is(marks.length, 1)
	t.is(marks[0].textContent, 'second paragraph')
	// It wraps real content, so it must not be hidden from the quote corpus
	t.is(marks[0].dataset.markerUi, undefined)

	// And it goes when the editor does
	const buttons = [...page.document.querySelectorAll('.marker-editor .marker-btn')]
	buttons.find(button => button.textContent === 'Cancel')
		.dispatchEvent(new page.window.MouseEvent('click', {bubbles: true}))
	await tick(10)
	t.falsy(page.document.querySelector('mark.marker-pending'))
})

test('the gutter numbers the file lines and marks the selected one', async t => {
	const page = await buildPage()
	await selectLine(page, 5)
	await pressEdit(page)

	const numbers = [...page.document.querySelectorAll('.marker-editor-lineno')]
	// Lines 2..8 of the file, by their own numbers rather than 1..7
	t.deepEqual(numbers.map(n => n.textContent), ['2', '3', '4', '5', '6', '7', '8'])
	// The line that was selected, against the context either side
	t.deepEqual(numbers.filter(n => n.classList.contains('selected')).map(n => n.textContent), ['5'])

	// A line added in the editor gets a number too
	const textarea = page.document.querySelector('.marker-editor textarea')
	textarea.value += '\nextra line'
	textarea.dispatchEvent(new page.window.Event('input', {bubbles: true}))
	await tick(10)
	t.is(page.document.querySelectorAll('.marker-editor-lineno').length, 8)
})

test('the selected lines and the selected text get their own layers', async t => {
	const page = await buildPage()
	await selectLine(page, 5)
	await pressEdit(page)

	// Where they sit is a matter of measurement, which jsdom has none of; that
	// they are in the frame ahead of the textarea, so the letters stay on top,
	// is what a rewrite could lose
	const frame = page.document.querySelector('.marker-editor-frame')
	const order = [...frame.children].map(child => child.className.replace('marker-textarea ', ''))
	t.deepEqual(order, [
		'marker-editor-gutter',
		'marker-editor-band',
		'marker-editor-quotes',
		'marker-editor-textarea',
		'marker-editor-measure'
	])
})

test('Apply writes the edited lines and closes the panel', async t => {
	const page = await buildPage()
	await selectLine(page, 5)
	await pressEdit(page)

	const panel = page.document.querySelector('.marker-editor')
	const textarea = panel.querySelector('textarea')
	const before = textarea.value
	textarea.value = before.replace('second paragraph', 'SECOND paragraph')
	textarea.dispatchEvent(new page.window.Event('input', {bubbles: true}))

	panel.querySelector('.marker-btn-primary')
		.dispatchEvent(new page.window.MouseEvent('click', {bubbles: true}))
	await tick(30)

	const written = page.calls.find(call => call.method === 'PATCH')
	t.truthy(written)
	t.is(written.body.lineStart, 2)
	t.is(written.body.lineEnd, 8)
	// The base is what the editor opened on, which is how the server locates
	// the range if something else moved it
	t.is(written.body.base, before)
	t.true(written.body.text.includes('SECOND paragraph'))

	t.falsy(page.document.querySelector('.marker-editor'))
	t.true(page.file.content.includes('SECOND paragraph'))
})

test('Cancel closes the panel and writes nothing', async t => {
	const page = await buildPage()
	await selectLine(page, 5)
	await pressEdit(page)

	const buttons = [...page.document.querySelectorAll('.marker-editor .marker-btn')]
	buttons.find(button => button.textContent === 'Cancel')
		.dispatchEvent(new page.window.MouseEvent('click', {bubbles: true}))
	await tick(10)

	t.falsy(page.document.querySelector('.marker-editor'))
	t.falsy(page.calls.find(call => call.method === 'PATCH'))
})

test('an open editor survives the content being swapped under it', async t => {
	const page = await buildPage()
	await selectLine(page, 5)
	await pressEdit(page)

	const textarea = page.document.querySelector('.marker-editor textarea')
	textarea.value = 'half-typed edit'
	textarea.dispatchEvent(new page.window.Event('input', {bubbles: true}))

	// What hot reload does: replace the content wholesale
	const swapped = await markdownToHTML(SOURCE)
	page.document.querySelector('#marker-content').innerHTML = swapped
	page.document.dispatchEvent(new page.window.CustomEvent('marker:reload'))
	await tick(40)

	const panels = page.document.querySelectorAll('.marker-editor')
	t.is(panels.length, 1)
	t.is(panels[0].querySelector('textarea').value, 'half-typed edit')
})

test('a plain re-render does not leave a second panel behind', async t => {
	const page = await buildPage()
	await selectLine(page, 5)
	await pressEdit(page)

	page.document.dispatchEvent(new page.window.CustomEvent('marker:comments'))
	await tick(40)
	t.is(page.document.querySelectorAll('.marker-editor').length, 1)
})

// The file changing under an open editor is the moment the reader has to be
// told that their base is no longer the whole story.
test('a change on disk raises the comparison pane', async t => {
	const page = await buildPage()
	await selectLine(page, 5)
	await pressEdit(page)
	t.falsy(page.document.querySelector('.marker-editor-disk'))

	page.file.content = SOURCE.replace('second paragraph', 'changed by someone else')
	page.document.dispatchEvent(new page.window.CustomEvent('marker:reload'))
	await tick(40)

	const pane = page.document.querySelector('.marker-editor-disk')
	t.truthy(pane)
	t.true(pane.textContent.includes('changed on disk'))
	// The comparison is the thread snapshot's, so it reads the same way
	t.truthy(pane.querySelector('.marker-diff-table'))
	const heads = [...pane.querySelectorAll('.marker-diff-head span')].map(span => span.textContent)
	t.deepEqual(heads, ['when opened', 'on disk'])
	// And it offers the choice, rather than picking a side
	const labels = [...pane.querySelectorAll('.marker-btn')].map(button => button.textContent)
	t.deepEqual(labels, ['Apply my Edit', 'Apply other\'s Edit'])
})

test('a refused write shows what is there now and can be forced', async t => {
	const refuse = body => body.force ? null : {
		status: 409,
		data: {
			error: {code: 'stale-content', message: 'Those lines no longer hold the text this edit was based on'},
			current: 'changed by someone else'
		}
	}
	const page = await buildPage({patch: refuse})
	await selectLine(page, 5)
	await pressEdit(page)

	page.document.querySelector('.marker-editor .marker-btn-primary')
		.dispatchEvent(new page.window.MouseEvent('click', {bubbles: true}))
	await tick(30)

	const pane = page.document.querySelector('.marker-editor-disk')
	t.truthy(pane)
	t.true(pane.textContent.includes('not applied'))
	// Still open: nothing was written and the text is not lost
	t.truthy(page.document.querySelector('.marker-editor'))

	pane.querySelector('.marker-editor-force')
		.dispatchEvent(new page.window.MouseEvent('click', {bubbles: true}))
	await tick(30)

	const forced = page.calls.filter(call => call.method === 'PATCH').at(-1)
	t.true(forced.body.force)
	t.falsy(page.document.querySelector('.marker-editor'))
})

// The live check runs on every reload, and would otherwise talk over the
// refusal that had just explained why nothing was written
test('a refusal keeps its wording when the disk view refreshes', async t => {
	const refuse = body => body.force ? null : {
		status: 409,
		data: {
			error: {code: 'stale-content', message: 'no'},
			current: 'changed by someone else'
		}
	}
	const page = await buildPage({patch: refuse})
	await selectLine(page, 5)
	await pressEdit(page)

	page.document.querySelector('.marker-editor .marker-btn-primary')
		.dispatchEvent(new page.window.MouseEvent('click', {bubbles: true}))
	await tick(30)
	t.true(page.document.querySelector('.marker-editor-disk-head').textContent.includes('not applied'))

	page.file.content = SOURCE.replace('second paragraph', 'changed by someone else')
	page.document.dispatchEvent(new page.window.CustomEvent('marker:reload'))
	await tick(40)

	t.true(page.document.querySelector('.marker-editor-disk-head').textContent.includes('not applied'))
})

test('Undo and Redo appear once an edit has been applied, and reverse it', async t => {
	const page = await buildPage()
	t.falsy(page.document.querySelector('#marker-undo'))

	await selectLine(page, 5)
	await pressEdit(page)
	const textarea = page.document.querySelector('.marker-editor textarea')
	const before = textarea.value
	textarea.value = before.replace('second paragraph', 'SECOND paragraph')
	textarea.dispatchEvent(new page.window.Event('input', {bubbles: true}))
	page.document.querySelector('.marker-editor .marker-btn-primary')
		.dispatchEvent(new page.window.MouseEvent('click', {bubbles: true}))
	await tick(30)

	const undo = page.document.querySelector('#marker-undo')
	const redo = page.document.querySelector('#marker-redo')
	t.truthy(undo)
	t.false(undo.disabled)
	// Nothing to redo until something is undone
	t.true(redo.disabled)

	undo.dispatchEvent(new page.window.MouseEvent('click', {bubbles: true}))
	await tick(30)

	const undone = page.calls.filter(call => call.method === 'PATCH').at(-1)
	// The write in reverse: what it applied becomes the base
	t.true(undone.body.base.includes('SECOND paragraph'))
	t.is(undone.body.text, before)
	t.is(page.file.content, SOURCE)
	t.false(page.document.querySelector('#marker-redo').disabled)

	page.document.querySelector('#marker-redo')
		.dispatchEvent(new page.window.MouseEvent('click', {bubbles: true}))
	await tick(30)
	t.true(page.file.content.includes('SECOND paragraph'))
})

/* ---------- the panel across a comments push and a reload ---------- */

test('the editor survives a comments push with its focus and caret', async t => {
	const page = await buildPage()
	await selectLine(page, 5)
	await pressEdit(page)
	const textarea = page.document.querySelector('.marker-editor textarea')
	textarea.focus()
	textarea.setSelectionRange(7, 7)
	textarea.dispatchEvent(new page.window.KeyboardEvent('keyup', {key: 'ArrowLeft', bubbles: true}))

	page.document.dispatchEvent(new page.window.CustomEvent('marker:comments', {detail: {fileId: 'abc123'}}))
	await tick(30)

	t.is(page.document.querySelector('.marker-editor textarea'), textarea)
	t.is(page.document.activeElement, textarea)
	t.is(textarea.selectionStart, 7)
	t.is(page.document.querySelectorAll('.marker-editor').length, 1)
})

test('after a reload the editor is rebuilt focused where the caret was, its selection marked again', async t => {
	const page = await buildPage()
	await selectLine(page, 5)
	await pressEdit(page)
	const before = page.document.querySelector('.marker-editor textarea')
	before.value = before.value.replace('second', 'SECOND')
	before.dispatchEvent(new page.window.Event('input', {bubbles: true}))
	before.focus()
	before.setSelectionRange(7, 7)
	before.dispatchEvent(new page.window.KeyboardEvent('keyup', {key: 'ArrowLeft', bubbles: true}))
	t.is(page.document.querySelectorAll('mark.marker-pending').length, 1)

	page.document.querySelector('#marker-content').innerHTML = await markdownToHTML(SOURCE)
	page.document.dispatchEvent(new page.window.CustomEvent('marker:reload'))
	await tick(40)

	const after = page.document.querySelector('.marker-editor textarea')
	t.truthy(after)
	t.not(after, before)
	t.true(after.value.includes('SECOND'))
	t.is(page.document.activeElement, after)
	t.is(after.selectionStart, 7)
	t.is(page.document.querySelectorAll('mark.marker-pending').length, 1)
	t.is(page.document.querySelector('mark.marker-pending').textContent, 'second paragraph')
})
