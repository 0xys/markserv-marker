'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('ava')
const {JSDOM} = require('jsdom')

const {markdownToHTML} = require('../lib/server')

const MD_COMMENTS_JS = fs.readFileSync(
	path.join(__dirname, '..', 'lib', 'templates', 'md-comments.js'), 'utf8')

const MARKDOWN = `# Title

<!-- block note -->

para <!-- inline note --> tail

<!--
multi
line
-->

<!-- -->

closing prose.
`

const tick = ms => new Promise(resolve => {
	setTimeout(resolve, ms)
})

const buildPage = async ({markdown = MARKDOWN, stored = null} = {}) => {
	const contentHtml = await markdownToHTML(markdown)
	const dom = new JSDOM(
		`<!DOCTYPE html><html data-theme="dark"><body>
			<article class="markdown-body"><div id="marker-content">${contentHtml}</div></article>
			<div class="page-controls"><button class="page-btn" id="theme-toggle"></button></div>
		</body></html>`,
		{url: 'http://localhost:7642/f/abc123/test.md', runScripts: 'outside-only'})

	const {window} = dom
	if (stored !== null) {
		window.localStorage.setItem('markserv-marker-md-comments', stored)
	}

	window.eval(MD_COMMENTS_JS)
	await tick(10)
	return {window, document: window.document}
}

const commentNodesUnder = root => {
	const walker = root.ownerDocument.createTreeWalker(root, 128 /* NodeFilter.SHOW_COMMENT */)
	const nodes = []
	while (walker.nextNode()) {
		nodes.push(walker.currentNode)
	}

	return nodes
}

test('each comment gets a span carrying its text, and the node itself stays', async t => {
	const {document} = await buildPage()

	const spans = [...document.querySelectorAll('.marker-md-comment')]
	// Block, inline and multi-line — the empty <!-- --> is skipped
	t.is(spans.length, 3)
	t.deepEqual(
		spans.map(span => span.textContent),
		[' block note ', ' inline note ', '\nmulti\nline\n'])

	for (const span of spans) {
		// The data-marker-ui mark keeps the note's text node out of the
		// quote-matching corpus while leaving it selectable and copyable
		t.is(span.dataset.markerUi, '')
		// Each span sits right after the comment node it shows
		t.is(span.previousSibling.nodeType, 8)
	}

	// The inline span stays inside its paragraph
	t.truthy(spans[1].closest('p'))

	// The comment nodes are untouched: remove the spans and nothing changed
	const content = document.querySelector('#marker-content')
	t.is(commentNodesUnder(content).length, 4)
})

test('the toggle button hides and shows through localStorage', async t => {
	const {window, document} = await buildPage()

	const button = document.querySelector('#md-comment-toggle')
	t.truthy(button)
	// Above the page frame on the article, not among the page-control buttons
	t.is(button.parentElement, document.querySelector('article.markdown-body'))
	t.falsy(button.closest('#marker-content'))
	t.false(document.body.classList.contains('marker-md-comments-hidden'))
	t.is(button.textContent, 'hide <!-- -->')

	button.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	t.true(document.body.classList.contains('marker-md-comments-hidden'))
	t.is(window.localStorage.getItem('markserv-marker-md-comments'), '0')
	t.is(button.textContent, 'show <!-- -->')
	t.true(button.classList.contains('is-off'))

	button.dispatchEvent(new window.MouseEvent('click', {bubbles: true}))
	t.false(document.body.classList.contains('marker-md-comments-hidden'))
	t.is(window.localStorage.getItem('markserv-marker-md-comments'), '1')
	t.is(button.textContent, 'hide <!-- -->')
	t.false(button.classList.contains('is-off'))
})

test('a stored hidden preference applies from the start', async t => {
	const {document} = await buildPage({stored: '0'})

	// Hidden is CSS-only: the decorations are still there, ready to show
	t.true(document.body.classList.contains('marker-md-comments-hidden'))
	t.is(document.querySelectorAll('.marker-md-comment').length, 3)
	t.true(document.querySelector('#md-comment-toggle').classList.contains('is-off'))
})

test('a document without comments gets no button', async t => {
	const {document} = await buildPage({markdown: '# Title\n\njust prose\n'})

	t.falsy(document.querySelector('.marker-md-comment'))
	t.falsy(document.querySelector('#md-comment-toggle'))
})

test('hot reload redecorates once, and an emptied document drops the button', async t => {
	const {window, document} = await buildPage()

	const swapped = await markdownToHTML(MARKDOWN.replace('closing prose.', 'edited prose.'))
	document.querySelector('#marker-content').innerHTML = swapped
	document.dispatchEvent(new window.CustomEvent('marker:reload'))
	await tick(10)

	t.is(document.querySelectorAll('.marker-md-comment').length, 3)
	t.truthy(document.querySelector('#md-comment-toggle'))

	// Decorating an already-decorated page must not double up either
	document.dispatchEvent(new window.CustomEvent('marker:reload'))
	await tick(10)
	t.is(document.querySelectorAll('.marker-md-comment').length, 3)

	const bare = await markdownToHTML('# Title\n\nno notes left\n')
	document.querySelector('#marker-content').innerHTML = bare
	document.dispatchEvent(new window.CustomEvent('marker:reload'))
	await tick(10)

	t.falsy(document.querySelector('.marker-md-comment'))
	t.falsy(document.querySelector('#md-comment-toggle'))
})

test('comment nodes inside injected UI are not the author\'s notes', async t => {
	const {window, document} = await buildPage()

	// What a rendered mermaid diagram looks like: a data-marker-ui subtree,
	// whose SVG may carry comment nodes of its own
	const diagram = document.createElement('div')
	diagram.dataset.markerUi = ''
	diagram.innerHTML = '<svg><!-- generator note --><text>A</text></svg>'
	document.querySelector('#marker-content').append(diagram)

	document.dispatchEvent(new window.CustomEvent('marker:reload'))
	await tick(10)

	t.is(document.querySelectorAll('.marker-md-comment').length, 3)
	t.falsy(diagram.querySelector('.marker-md-comment'))
})
