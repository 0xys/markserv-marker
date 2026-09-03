'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('ava')
const {JSDOM} = require('jsdom')

const {markdownToHTML} = require('../lib/server')

const DIFF_CORE_JS = fs.readFileSync(
	path.join(__dirname, '..', 'lib', 'templates', 'diff-core.js'), 'utf8')
const DIFF_BLOCK_JS = fs.readFileSync(
	path.join(__dirname, '..', 'lib', 'templates', 'diff-block.js'), 'utf8')

const fence = lines => '```diff\n' + lines.join('\n') + '\n```\n'

const GIT_DIFF = fence([
	'diff --git a/x.js b/x.js',
	'--- a/x.js',
	'+++ b/x.js',
	'@@ -12,4 +12,5 @@ function f() {',
	'   const a = 1',
	'-  const b = 2',
	'+  const b = 3',
	'+  const c = 4',
	'   done'
])

const tick = ms => new Promise(resolve => {
	setTimeout(resolve, ms)
})

const buildPage = async ({markdown = GIT_DIFF, stored = null} = {}) => {
	const contentHtml = await markdownToHTML(markdown)
	const dom = new JSDOM(
		`<!DOCTYPE html><html data-theme="dark"><body>
			<article class="markdown-body"><div id="marker-content">${contentHtml}</div></article>
		</body></html>`,
		{url: 'http://localhost:7642/f/abc123/test.md', runScripts: 'outside-only'})

	const {window} = dom
	if (stored !== null) {
		window.localStorage.setItem('markserv-marker-diff-view', stored)
	}

	window.eval(DIFF_CORE_JS)
	window.eval(DIFF_BLOCK_JS)
	await tick(20)
	return {window, document: window.document}
}

// Reads a row as "leftNo|leftText||rightNo|rightText", or "wide:text"
const rowsOf = document => [...document.querySelectorAll('.marker-diffblock-table tr')]
	.map(tr => {
		const cells = [...tr.children]
		if (cells.length === 1) {
			return 'wide:' + cells[0].textContent
		}

		return cells[0].textContent + '|' + cells[1].textContent +
			'||' + cells[2].textContent + '|' + cells[3].textContent
	})

test('a diff block is compared side by side by default, with the source kept', async t => {
	const {document} = await buildPage()

	const wrapper = document.querySelector('.marker-diffblock')
	t.is(wrapper.dataset.mode, 'split')
	t.truthy(wrapper.querySelector('.marker-diffblock-view'))
	t.truthy(wrapper.querySelector('.marker-diffblock-toggle'))

	// The source view is untouched: it is what carries the comments
	const code = wrapper.querySelector('pre > code')
	t.is(code.dataset.sourceLine, '1')
	t.true(code.textContent.includes('-  const b = 2'))

	// Everything the browser added is UI, or its text would join the
	// quote-matching corpus and shift quoteIndex counting document-wide
	const added = wrapper.querySelectorAll('.marker-diffblock-view, .marker-diffblock-view *, .marker-diffblock-toggle, .marker-diffblock-toggle *')
	t.true(added.length > 10)
	for (const node of added) {
		t.is(node.dataset.markerUi, '')
	}

	// Marking the wrapper would make its source uncommentable
	t.is(wrapper.dataset.markerUi, undefined)
	t.is(wrapper.dataset.sourceLine, undefined)
})

test('rows pair up and carry each side line numbers', async t => {
	const {document} = await buildPage()

	t.deepEqual(rowsOf(document), [
		'wide:diff --git a/x.js b/x.js',
		'wide:--- a/x.js',
		'wide:+++ b/x.js',
		'wide:@@ -12,4 +12,5 @@ function f() {',
		'12|  const a = 1||12|  const a = 1',
		'13|  const b = 2||13|  const b = 3',
		// An addition with nothing to pair against leaves the other side empty
		'|||14|  const c = 4',
		'14|  done||15|  done'
	])
})

test('only the changed words of a paired line are highlighted', async t => {
	const {document} = await buildPage()

	const changed = [...document.querySelectorAll('.marker-diffblock-cell .chg')]
		.map(node => node.textContent)
	t.deepEqual(changed, ['2', '3'])
})

// The common hand-written case: no @@ header, no file header, just the two
// versions. Requiring a hunk header would leave most blocks uncompared.
// The comparison is coloured by its own classes in diff-block.css, and the
// unified source keeps highlight.js's. What the values resolve to is a
// stylesheet matter and needs a real browser; the classes are checkable here.
test('the rows carry the classes the palette is written against', async t => {
	const {document} = await buildPage()

	t.truthy(document.querySelector('.marker-diffblock-cell.del'))
	t.truthy(document.querySelector('.marker-diffblock-cell.add'))
	t.truthy(document.querySelector('.marker-diffblock-cell.ctx'))
	t.truthy(document.querySelector('.marker-diffblock-meta'))
	t.truthy(document.querySelector('.marker-diffblock-hunk'))
	// Nothing in the comparison borrows the source's highlighting classes
	t.falsy(document.querySelector('.marker-diffblock-view [class*="hljs"]'))
})

test('a block with no hunk header is still compared, without line numbers', async t => {
	const {document} = await buildPage({markdown: fence(['-const b = 2', '+const b = 3'])})

	const wrapper = document.querySelector('.marker-diffblock')
	t.is(wrapper.dataset.mode, 'split')
	t.deepEqual(rowsOf(document), ['|const b = 2|||const b = 3'])

	// Nothing to put in the gutters, and two short columns fit in the body
	// column, so the block neither reserves gutter room nor widens
	t.true(document.querySelector('.marker-diffblock-table').classList.contains('no-numbers'))
	t.false(wrapper.classList.contains('is-wide'))
})

// The room is taken only by blocks whose lines cannot be read without it: a
// two-word diff spanning the whole window reads as a mistake
test('a block earns the extra width only when its lines need it', async t => {
	const long = 'x'.repeat(80)
	const {document} = await buildPage({
		markdown: fence(['@@ -1 +1 @@', '-' + long + 'a', '+' + long + 'b'])
	})

	t.true(document.querySelector('.marker-diffblock').classList.contains('is-wide'))
})

test('CJK counts double when deciding a block needs the width', async t => {
	// 40 characters of Japanese take 80 monospace columns
	const long = 'あ'.repeat(40)
	const {document} = await buildPage({
		markdown: fence(['@@ -1 +1 @@', '-' + long + 'x', '+' + long + 'y'])
	})

	t.true(document.querySelector('.marker-diffblock').classList.contains('is-wide'))
})

test('a hunk header with the counts omitted means one line each', async t => {
	const {document} = await buildPage({markdown: fence(['@@ -1 +1 @@', '-a', '+b'])})

	t.deepEqual(rowsOf(document), ['wide:@@ -1 +1 @@', '1|a||1|b'])
})

test('the no-newline marker consumes no line number and follows its lines', async t => {
	const {document} = await buildPage({
		markdown: fence([
			'@@ -1,2 +1,2 @@',
			' keep',
			'-old',
			'\\ No newline at end of file',
			'+new',
			'\\ No newline at end of file'
		])
	})

	t.deepEqual(rowsOf(document), [
		'wide:@@ -1,2 +1,2 @@',
		'1|keep||1|keep',
		// Paired despite the marker sitting between the two lines
		'2|old||2|new',
		'wide:\\ No newline at end of file',
		'wide:\\ No newline at end of file'
	])
})

test('two files in one block each start their own line numbering', async t => {
	const {document} = await buildPage({
		markdown: fence([
			'diff --git a/a.txt b/a.txt',
			'@@ -1,1 +1,1 @@',
			'-one',
			'+ONE',
			'diff --git a/b.txt b/b.txt',
			'@@ -5,1 +5,1 @@',
			'-two',
			'+TWO'
		])
	})

	t.deepEqual(rowsOf(document), [
		'wide:diff --git a/a.txt b/a.txt',
		'wide:@@ -1,1 +1,1 @@',
		'1|one||1|ONE',
		'wide:diff --git a/b.txt b/b.txt',
		'wide:@@ -5,1 +5,1 @@',
		'5|two||5|TWO'
	])
})

test('a block holding no diff keeps its source and gets no toggle', async t => {
	const {document} = await buildPage({markdown: fence(['just prose', 'more prose'])})

	const wrapper = document.querySelector('.marker-diffblock')
	t.is(wrapper.dataset.mode, undefined)
	t.falsy(wrapper.querySelector('.marker-diffblock-view'))
	t.falsy(wrapper.querySelector('.marker-diffblock-toggle'))
	t.falsy(wrapper.querySelector('.marker-diffblock-reason'))
})

test('a combined merge diff says why it was left as source', async t => {
	const {document} = await buildPage({
		markdown: fence([
			'@@@ -1,2 -1,2 +1,3 @@@',
			'  ctx',
			'- a',
			'+ b'
		])
	})

	const wrapper = document.querySelector('.marker-diffblock')
	t.is(wrapper.dataset.mode, undefined)
	t.falsy(wrapper.querySelector('.marker-diffblock-toggle'))
	const reason = wrapper.querySelector('.marker-diffblock-reason')
	t.true(reason.textContent.includes('Combined diff'))
	t.is(reason.dataset.markerUi, '')
})

test('the toggle switches that block alone and survives a hot reload', async t => {
	const twoBlocks = GIT_DIFF + '\n' + fence(['-x', '+y'])
	const {window, document} = await buildPage({markdown: twoBlocks})

	const [first, second] = document.querySelectorAll('.marker-diffblock')
	const button = first.querySelector('.marker-diffblock-toggle')
	// The label is the view you are looking at, not what a click does
	t.is(button.textContent, '⇆ split')

	button.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	t.is(first.dataset.mode, 'unified')
	t.is(second.dataset.mode, 'split')
	t.is(first.querySelector('.marker-diffblock-toggle').textContent, '</> unified')

	// Hot reload swaps #marker-content wholesale; the ordinal keying is what
	// carries the choice across it
	const swapped = await markdownToHTML(twoBlocks.replace('const a = 1', 'const a = 9'))
	document.querySelector('#marker-content').innerHTML = swapped
	document.dispatchEvent(new window.CustomEvent('marker:reload'))
	await tick(20)

	const reloaded = document.querySelectorAll('.marker-diffblock')
	t.is(reloaded[0].dataset.mode, 'unified')
	t.is(reloaded[1].dataset.mode, 'split')
	// Rebuilt once, not twice
	t.is(reloaded[0].querySelectorAll('.marker-diffblock-view').length, 0)
	t.is(reloaded[1].querySelectorAll('.marker-diffblock-view').length, 1)
	t.is(reloaded[0].querySelectorAll('.marker-diffblock-toggle').length, 1)
})

// Hiding the inactive view with CSS left it in the DOM between the source and
// the toggle, and a selection dragged past the end of a line ran on through it:
// the other side's text and the line numbers joined the quote, and the endpoint
// landed inside marked-up UI, where the Comment button never appears.
test('only the view being shown is in the DOM', async t => {
	const {window, document} = await buildPage()
	const wrapper = document.querySelector('.marker-diffblock')

	t.is(wrapper.querySelectorAll('.marker-diffblock-view').length, 1)

	wrapper.querySelector('.marker-diffblock-toggle')
		.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	t.is(wrapper.dataset.mode, 'unified')
	t.is(wrapper.querySelectorAll('.marker-diffblock-view').length, 0)
	// Nothing of the comparison is left to be selected along with the source
	t.is(wrapper.querySelectorAll('.marker-diffblock-table').length, 0)

	// And back, rebuilt from the parse it kept rather than re-read
	wrapper.querySelector('.marker-diffblock-toggle')
		.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	t.is(wrapper.dataset.mode, 'split')
	t.is(wrapper.querySelectorAll('.marker-diffblock-view').length, 1)
	t.deepEqual(rowsOf(document), [
		'wide:diff --git a/x.js b/x.js',
		'wide:--- a/x.js',
		'wide:+++ b/x.js',
		'wide:@@ -12,4 +12,5 @@ function f() {',
		'12|  const a = 1||12|  const a = 1',
		'13|  const b = 2||13|  const b = 3',
		'|||14|  const c = 4',
		'14|  done||15|  done'
	])

	// The comparison sits before the toggle, so the toggle stays the last
	// child and a selection reaching it has passed nothing but the source
	t.is(wrapper.lastElementChild.className, 'marker-diffblock-toggle')
})

test('the last explicit choice becomes the default for the next page', async t => {
	const {document} = await buildPage({stored: 'unified'})

	t.is(document.querySelector('.marker-diffblock').dataset.mode, 'unified')
})

// A selection that spans rows becomes a cell selection, and the browser then
// hands over every cell it touches — so dragging down one column used to copy
// the other column's text along with it, tab-separated. Which side is locked
// is all jsdom can check: whether user-select actually keeps the other side
// out of the selection needs a real browser.
test('the side a drag starts on is locked, the other steps aside', async t => {
	const {window, document} = await buildPage()
	const view = document.querySelector('.marker-diffblock-view')

	const press = node => node.dispatchEvent(
		new window.MouseEvent('mousedown', {bubbles: true}))

	press(document.querySelector('.marker-diffblock-cell.marker-diffblock-new'))
	t.true(view.classList.contains('select-new'))
	t.false(view.classList.contains('select-old'))

	press(document.querySelector('.marker-diffblock-cell.marker-diffblock-old'))
	t.true(view.classList.contains('select-old'))
	t.false(view.classList.contains('select-new'))

	// Gutters belong to a side too, so starting on a line number locks it
	press(document.querySelector('.marker-diffblock-no.marker-diffblock-new'))
	t.true(view.classList.contains('select-new'))

	// A file or hunk header belongs to neither; locking to the old side anyway
	// keeps a drag that starts there from picking up both columns
	press(document.querySelector('.marker-diffblock-hunk'))
	t.true(view.classList.contains('select-old'))
})

test('the badge counts unresolved threads, not highlights', async t => {
	const {window, document} = await buildPage()

	const code = document.querySelector('.marker-diffblock pre > code')
	code.innerHTML =
		'<mark class="marker-quote" data-thread-id="t1">a</mark>' +
		'<mark class="marker-quote" data-thread-id="t1">b</mark>' +
		'<mark class="marker-quote" data-thread-id="t2">c</mark>' +
		'<mark class="marker-quote resolved" data-thread-id="t3">d</mark>'
	document.dispatchEvent(new window.CustomEvent('marker:rendered'))
	await tick(10)

	const badge = document.querySelector('.marker-diffblock-count')
	t.is(badge.textContent, '2')
	t.is(badge.dataset.markerUi, '')
})

// Comment highlights live inside the same <code> the parser reads. They add no
// characters, which is why textContent stays the right way to read the source
// and the two features need no ordering between them.
test('quote highlights in the source do not leak into the comparison', async t => {
	const {window, document} = await buildPage()

	const code = document.querySelector('.marker-diffblock pre > code')
	const text = code.textContent
	code.innerHTML = '<mark class="marker-quote" data-thread-id="t1">' +
		code.innerHTML + '</mark>'
	t.is(code.textContent, text)

	document.dispatchEvent(new window.CustomEvent('marker:reload'))
	await tick(20)

	t.falsy(document.querySelector('.marker-diffblock-table mark'))
	t.true(rowsOf(document).includes('13|  const b = 2||13|  const b = 3'))
})
