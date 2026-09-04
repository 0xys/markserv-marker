'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('ava')
const getPort = require('get-port')

const server = require('../lib/server')
const registry = require('../lib/registry')

let service
let base
let fixtureDir

// Line 4 is the hunk header, so line 7 is "+  const b = 3"
const PATCH = [
	'diff --git a/x.js b/x.js',
	'--- a/x.js',
	'+++ b/x.js',
	'@@ -12,4 +12,5 @@ function f() {',
	'   const a = 1',
	'-  const b = 2',
	'+  const b = 3',
	'+  const c = 4',
	'   done',
	''
].join('\n')

test.before(async () => {
	fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-diff-test-'))
	fs.writeFileSync(path.join(fixtureDir, 'change.diff'), PATCH)
	fs.writeFileSync(path.join(fixtureDir, 'change.patch'), PATCH)
	fs.writeFileSync(path.join(fixtureDir, 'empty.diff'), '')
	fs.writeFileSync(path.join(fixtureDir, 'evil.diff'),
		'@@ -1,1 +1,1 @@\n-<script>alert(1)</script>\n+safe\n')

	const port = await getPort()
	service = await server.init({
		port,
		address: 'localhost',
		silent: true,
		hotreload: false,
		theme: 'dark'
	})
	base = `http://localhost:${port}`
})

test.after.always(() => {
	registry.reset()
	if (service) {
		service.close()
	}
})

const post = (url, body) => fetch(url, {
	method: 'POST',
	headers: {'content-type': 'application/json'},
	body: JSON.stringify(body)
})

const register = name => registry.register(path.join(fixtureDir, name)).reg

test.serial('a .diff file is served as a diff block, not as a download', async t => {
	const reg = register('change.diff')
	const response = await fetch(`${base}${reg.urlPath}`)

	t.is(response.status, 200)
	t.regex(response.headers.get('content-type'), /text\/html/)

	const html = await response.text()
	t.true(html.includes('<div class="marker-diffblock tex2jax_ignore mathjax_ignore" data-marker-wrapper>'))
	// The whole file is one block, anchored at its own first and last lines
	t.true(html.includes('<pre data-source-line="1" data-source-line-end="9">'))
	t.true(html.includes('class="language-diff"'))
	t.true(html.includes('<span class="hljs-addition">+  const b = 3</span>'))

	// The comment UI is what the page exists for
	t.true(html.includes(`fileId: '${reg.id}'`))
	t.true(html.includes('templates/comments.js'))
	t.true(html.includes('templates/diff-core.js'))
	t.true(html.includes('templates/diff-block.js'))
})

test.serial('.patch is served the same way', async t => {
	const reg = register('change.patch')
	const html = await fetch(`${base}${reg.urlPath}`).then(response => response.text())

	t.true(html.includes('marker-diffblock'))
	t.true(html.includes('<pre data-source-line="1" data-source-line-end="9">'))
})

test.serial('a patch touching HTML is escaped, not executed', async t => {
	const reg = register('evil.diff')
	const html = await fetch(`${base}${reg.urlPath}`).then(response => response.text())

	t.true(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
	t.false(html.includes('<script>alert(1)</script>'))
})

test.serial('an empty .diff file renders a range the comment API accepts', async t => {
	const reg = register('empty.diff')
	const html = await fetch(`${base}${reg.urlPath}`).then(response => response.text())

	// Never 1..0: lib/api.js rejects lineEnd < lineStart
	t.true(html.includes('<pre data-source-line="1" data-source-line-end="1">'))
})

// The point of stamping the file's own line numbers: a comment made on the
// whole block narrows to the line its quote actually sits on. An off-by-one
// from a synthetic fence wrapper would show up right here.
test.serial('a comment on a .diff file narrows to the quoted line', async t => {
	const reg = register('change.diff')

	const response = await post(`${base}/api/files/${reg.id}/comments`, {
		lineStart: 1,
		lineEnd: 9,
		quote: 'const b = 3',
		author: 'reviewer',
		body: 'why not 4?'
	})
	t.is(response.status, 201)

	const threads = await fetch(`${base}/api/files/${reg.id}/comments`)
		.then(r => r.json())
	const thread = threads.threads.at(-1)

	t.is(thread.lineStart, 7)
	t.is(thread.lineEnd, 7)
	t.is(thread.snapshot.text, '+  const b = 3')
	t.false(thread.changed)
})

test.serial('the file content endpoint works for a .diff file', async t => {
	const reg = register('change.diff')
	const content = await fetch(`${base}/api/files/${reg.id}/content`)
		.then(response => response.json())

	t.is(content.lines, 10)
	t.true(content.content.startsWith('diff --git'))
})
