'use strict'

const test = require('ava')

const {markdownToHTML} = require('../lib/server')

const fixture = `# Heading

A paragraph
spanning two lines.

- item one
- item two
  - nested item

\`\`\`js
console.log(1)
\`\`\`

> quoted

| a | b |
| - | - |
| 1 | 2 |

---
`

const attrs = html => {
	const found = []
	const pattern = /<(\w+)[^>]*data-source-line="(\d+)" data-source-line-end="(\d+)"/g
	let match
	while ((match = pattern.exec(html)) !== null) {
		found.push({tag: match[1], start: Number(match[2]), end: Number(match[3])})
	}

	return found
}

test('block elements carry 1-based source line ranges', async t => {
	const html = await markdownToHTML(fixture)
	const anchored = attrs(html)

	const byTag = tag => anchored.filter(a => a.tag === tag)

	t.deepEqual(byTag('h1')[0], {tag: 'h1', start: 1, end: 1})
	t.deepEqual(byTag('p')[0], {tag: 'p', start: 3, end: 4})
	// Markdown-it extends a list's map through its trailing blank line
	t.deepEqual(byTag('ul')[0], {tag: 'ul', start: 6, end: 9})
	t.deepEqual(byTag('blockquote')[0], {tag: 'blockquote', start: 14, end: 14})
	t.deepEqual(byTag('table')[0], {tag: 'table', start: 16, end: 18})
	t.deepEqual(byTag('hr')[0], {tag: 'hr', start: 20, end: 20})
})

test('fenced code blocks keep line anchors despite highlightjs', async t => {
	const html = await markdownToHTML(fixture)
	const pre = attrs(html).filter(a => a.tag === 'pre')
	t.deepEqual(pre[0], {tag: 'pre', start: 10, end: 12})
	// Highlighting still applied
	t.true(html.includes('hljs'))
})

// Its own document rather than an addition to `fixture`, whose line numbers
// every assertion above hardcodes
test('mermaid fences keep the same line anchors as any other fence', async t => {
	const html = await markdownToHTML('```mermaid\ngraph TD;\n```\n')
	const anchored = attrs(html)
	t.deepEqual(anchored.filter(a => a.tag === 'pre')[0], {tag: 'pre', start: 1, end: 3})
	t.deepEqual(anchored.filter(a => a.tag === 'code')[0], {tag: 'code', start: 1, end: 3})
})

test('frontmatter renders as a details block without shifting line anchors', async t => {
	const withFrontmatter = `---
name: test
description: something
---

# Real heading

Body text.
`
	const html = await markdownToHTML(withFrontmatter)

	// Frontmatter becomes a collapsible block anchored to its source lines
	t.true(html.includes('<details class="frontmatter" open data-source-line="1" data-source-line-end="4">'))
	t.true(html.includes('name: test'))
	// No stray hr / setext heading from the --- fences
	t.false(html.includes('<hr'))
	t.false(html.includes('<h2'))

	// Content below keeps its true source lines (heading is on line 6)
	const heading = attrs(html).find(a => a.tag === 'h1')
	t.deepEqual(heading, {tag: 'h1', start: 6, end: 6})
	const paragraph = attrs(html).find(a => a.tag === 'p')
	t.deepEqual(paragraph, {tag: 'p', start: 8, end: 8})
})

test('external links open in a new tab, internal links do not', async t => {
	const html = await markdownToHTML(
		'[ext](https://example.com) [sibling](./other.md) [anchor](#heading)\n')

	t.true(html.includes(
		'<a href="https://example.com" target="_blank" rel="noopener noreferrer">ext</a>'))
	t.true(html.includes('<a href="./other.md">sibling</a>'))
	t.true(html.includes('<a href="#heading">anchor</a>'))
})

test('a --- later in the document is not treated as frontmatter', async t => {
	const html = await markdownToHTML('# Title\n\n---\n\ntext\n')
	t.false(html.includes('frontmatter'))
	t.true(html.includes('<hr'))
})

test('list items carry their own line anchors', async t => {
	const html = await markdownToHTML(fixture)
	const items = attrs(html).filter(a => a.tag === 'li')
	t.true(items.some(a => a.start === 6 && a.end === 6))
	t.true(items.some(a => a.start === 7 && a.end === 9))
})

test('HTML comments pass through the render verbatim', async t => {
	// The browser receives real comment nodes; making them visible is done
	// client-side by lib/templates/md-comments.js, never by the server
	const html = await markdownToHTML(
		'# Title\n\n<!-- block note -->\n\npara <!-- inline note --> tail\n')

	t.true(html.includes('<!-- block note -->'))
	t.true(html.includes('para <!-- inline note --> tail'))
})

test('a comment opener followed by a ==== ruler is not a setext heading', async t => {
	// Markdown-it 10 ran setext headings before html_block, turning the
	// opener into <h1><!--</h1>; the re-registered rule order in server.js
	// gives the HTML block precedence, as CommonMark and markdown-it 11+ do
	const html = await markdownToHTML(
		'<!--\n====\nusage notes\n====\n-->\n\nafter the comment\n')

	t.false(html.includes('<h1'))
	t.true(html.includes('<!--\n====\nusage notes\n====\n-->'))
	// The lines the comment occupies still count for what follows
	const after = attrs(html).find(a => a.tag === 'p')
	t.deepEqual(after, {tag: 'p', start: 7, end: 7})
})

test('a diff fence keeps the same line anchors as any other fence', async t => {
	// Its own document: the shared fixture's line numbers are hardcoded above.
	// The wrapper lib/diff-fence.js adds must not hide the pre from the
	// injection this plugin does, which is why it wraps the output rather than
	// replacing the renderer.
	const html = await markdownToHTML(
		'intro\n\n```diff\n-const b = 2\n+const b = 3\n```\n\nafter\n')
	const anchored = attrs(html)

	t.deepEqual(anchored.filter(a => a.tag === 'pre'), [{tag: 'pre', start: 3, end: 6}])
	t.deepEqual(anchored.filter(a => a.tag === 'code'), [{tag: 'code', start: 3, end: 6}])
	// Nothing on the wrapper: it would rival the pre as an anchor for the
	// same lines, and comments.js picks the smallest enclosing range
	t.notRegex(html, /<div[^>]*data-source-line/)
	t.deepEqual(anchored.filter(a => a.tag === 'p'),
		[{tag: 'p', start: 1, end: 1}, {tag: 'p', start: 8, end: 8}])
})
