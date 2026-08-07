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

test.before(async () => {
	fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-test-'))
	fs.writeFileSync(path.join(fixtureDir, 'doc.md'),
		'# Title\n\nA paragraph.\n\n![pic](./pic.png)\n')
	fs.writeFileSync(path.join(fixtureDir, 'pic.png'),
		Buffer.from('89504e470d0a1a0a', 'hex'))
	fs.mkdirSync(path.join(fixtureDir, 'sub'))
	fs.writeFileSync(path.join(fixtureDir, 'sub', 'nested.md'), '# Nested\n')

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

test.serial('health endpoint identifies the daemon', async t => {
	const response = await fetch(`${base}/api/health`)
	t.is(response.status, 200)
	const health = await response.json()
	t.is(health.name, 'markserv-marker')
	t.is(health.pid, process.pid)
	t.truthy(health.startedAt)
})

test.serial('registration is idempotent and listable', async t => {
	const docPath = path.join(fixtureDir, 'doc.md')

	const first = await post(`${base}/api/files`, {path: docPath})
	t.is(first.status, 201)
	const reg = await first.json()
	t.true(reg.created)
	t.is(reg.type, 'file')
	t.regex(reg.url, /\/f\/[\da-f]{10}\/doc\.md$/)

	const second = await post(`${base}/api/files`, {path: docPath})
	t.is(second.status, 200)
	const again = await second.json()
	t.false(again.created)
	t.is(again.id, reg.id)

	const listResponse = await fetch(`${base}/api/files`)
	const list = await listResponse.json()
	t.is(list.files.filter(file => file.id === reg.id).length, 1)
})

test.serial('registering a missing path yields 404', async t => {
	const response = await post(`${base}/api/files`, {path: '/no/such/file.md'})
	t.is(response.status, 404)
	const body = await response.json()
	t.is(body.error.code, 'file-not-found')
})

test.serial('registered markdown renders with content and line anchors', async t => {
	const {reg} = registry.register(path.join(fixtureDir, 'doc.md'))
	const response = await fetch(`${base}${reg.urlPath}`)
	t.is(response.status, 200)
	const html = await response.text()
	t.true(html.includes('A paragraph.'))
	t.true(html.includes('data-source-line'))
	t.true(html.includes('window.__marker'))
	t.true(html.includes(reg.id))
})

test.serial('relative assets next to the file are served', async t => {
	const {reg} = registry.register(path.join(fixtureDir, 'doc.md'))
	const response = await fetch(`${base}/f/${reg.id}/pic.png`)
	t.is(response.status, 200)
	t.is(response.headers.get('content-type'), 'image/png')
})

test.serial('sibling markdown under the same root is commentable under its own id', async t => {
	const {reg} = registry.register(path.join(fixtureDir, 'doc.md'))
	const nestedPath = fs.realpathSync(path.join(fixtureDir, 'sub', 'nested.md'))
	const response = await fetch(`${base}/f/${reg.id}/sub/nested.md`)
	t.is(response.status, 200)
	const html = await response.text()
	t.true(html.includes('Nested'))

	// Comments live on a registration of the file itself, not on the
	// registration the reader came in through
	const nestedReg = registry.list().find(entry => entry.path === nestedPath)
	t.truthy(nestedReg)
	t.is(nestedReg.type, 'file')
	t.true(html.includes(`fileId: '${nestedReg.id}'`))
})

test.serial('directory registrations get a listing with breadcrumbs', async t => {
	const {reg} = registry.register(fixtureDir)
	const response = await fetch(`${base}/f/${reg.id}/`)
	t.is(response.status, 200)
	const html = await response.text()
	t.true(html.includes('doc.md'))
	t.true(html.includes('sub/'))

	const redirect = await fetch(`${base}/f/${reg.id}/sub`, {redirect: 'manual'})
	t.is(redirect.status, 301)
	t.is(redirect.headers.get('location'), `/f/${reg.id}/sub/`)
})

test.serial('markdown opened through a directory registration accepts comments', async t => {
	const {reg} = registry.register(fixtureDir)
	t.is(reg.type, 'dir')

	const response = await fetch(`${base}/f/${reg.id}/doc.md`)
	t.is(response.status, 200)
	const html = await response.text()
	t.true(html.includes('window.__marker'))
	t.true(html.includes('comments.js'))

	// The page comments under the file's own registration, not the directory's
	const docId = registry.register(path.join(fixtureDir, 'doc.md')).reg.id
	t.not(docId, reg.id)
	t.true(html.includes(`fileId: '${docId}'`))

	const created = await post(`${base}/api/files/${docId}/comments`, {
		author: 'human',
		body: 'from the folder view',
		lineStart: 3,
		lineEnd: 3,
		quote: 'A paragraph.'
	})
	t.is(created.status, 201)

	const listed = await fetch(`${base}/api/files/${docId}/comments`)
	const threads = await listed.json()
	t.is(threads.threads.length, 1)
	t.is(threads.threads[0].body, 'from the folder view')
	t.is(registry.get(reg.id).comments.size, 0)
})

test.serial('path traversal outside the root is rejected', async t => {
	const {reg} = registry.register(path.join(fixtureDir, 'doc.md'))
	const response = await fetch(`${base}/f/${reg.id}/..%2f..%2f..%2fetc%2fpasswd`)
	t.is(response.status, 403)
})

test.serial('unknown registration ids yield 404', async t => {
	const response = await fetch(`${base}/f/ffffffffff/x.md`)
	t.is(response.status, 404)
})

test.serial('index page lists registered files', async t => {
	registry.register(path.join(fixtureDir, 'doc.md'))
	const response = await fetch(`${base}/`)
	t.is(response.status, 200)
	const html = await response.text()
	t.true(html.includes('doc.md'))
	t.true(html.includes('markserv-marker'))
})

// A tree of index.md files is indistinguishable by name alone, so the index
// shows each document's own title beside it
test.serial('index rows show the markdown title next to the file name', async t => {
	const titleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-titles-'))
	const write = (name, body) => {
		const filePath = path.join(titleDir, name)
		fs.writeFileSync(filePath, body)
		return registry.register(filePath).reg.id
	}

	const ids = [
		write('heading.md', '# Deposit flow\n\nbody\n'),
		// Frontmatter wins over a heading below it
		write('front.md', '---\ntitle: "Staking rewards"\n---\n\n# Ignored heading\n'),
		write('setext.md', 'Underlined title\n================\n\nbody\n'),
		// Emphasis and links are stripped so the column stays readable
		write('inline.md', '# The **bold** [linked](http://example.com) `code` doc\n'),
		// A hash inside a fence is not a heading
		write('fenced.md', '```sh\n# not a title\n```\n\n# Real title\n'),
		write('none.md', 'Just a paragraph, no heading at all.\n')
	]

	const response = await fetch(`${base}/`)
	const html = await response.text()

	t.true(html.includes('<span class="marker-doc-title">Deposit flow</span>'))
	t.true(html.includes('<span class="marker-doc-title">Staking rewards</span>'))
	t.false(html.includes('Ignored heading'))
	t.true(html.includes('<span class="marker-doc-title">Underlined title</span>'))
	t.true(html.includes('<span class="marker-doc-title">The bold linked code doc</span>'))
	t.true(html.includes('<span class="marker-doc-title">Real title</span>'))
	t.false(html.includes('not a title'))

	// A file with no heading still lists, just without the extra span
	const rowOf = name => (html.match(/<tr>[\s\S]*?<\/tr>/g) || [])
		.find(row => row.includes('>' + name + '</a>'))
	t.truthy(rowOf('none.md'))
	t.false(rowOf('none.md').includes('marker-doc-title'))
	t.true(rowOf('heading.md').includes('marker-doc-title'))

	// The file name is never replaced by the title
	t.true(html.includes('>heading.md</a>'))

	for (const id of ids) {
		registry.unregister(id)
	}
})

test.serial('a title is not read from a file that has gone away', async t => {
	const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-gone-'))
	const filePath = path.join(gone, 'vanishes.md')
	fs.writeFileSync(filePath, '# Here for now\n')
	const {reg} = registry.register(filePath)
	fs.rmSync(filePath)

	const response = await fetch(`${base}/`)
	t.is(response.status, 200)
	const html = await response.text()
	t.true(html.includes('vanishes.md'))
	t.false(html.includes('Here for now'))

	registry.unregister(reg.id)
})

test.serial('unregistering removes the file', async t => {
	const {reg} = registry.register(path.join(fixtureDir, 'doc.md'))
	const response = await fetch(`${base}/api/files/${reg.id}`, {method: 'DELETE'})
	t.is(response.status, 204)

	const page = await fetch(`${base}/f/${reg.id}/doc.md`)
	t.is(page.status, 404)

	// Re-register for later tests
	registry.register(path.join(fixtureDir, 'doc.md'))
})

test.serial('non-API, non-registered paths yield 404', async t => {
	const response = await fetch(`${base}/random/path`)
	t.is(response.status, 404)
})

test.serial('index rows carry unregister buttons and paginate past 20 files', async t => {
	const pageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-paging-'))
	const ids = []
	for (let i = 0; i < 25; i++) {
		const filePath = path.join(pageDir, `file-${String(i).padStart(2, '0')}.md`)
		fs.writeFileSync(filePath, `# File ${i}\n`)
		ids.push(registry.register(filePath).reg.id)
	}

	const countRows = html => (html.match(/<button class="marker-unregister"/g) || []).length

	const response1 = await fetch(`${base}/`)
	const page1 = await response1.text()
	t.is(countRows(page1), 20)
	t.true(page1.includes('marker-pager'))
	t.true(page1.includes('/?page=2'))

	const response2 = await fetch(`${base}/?page=2`)
	const page2 = await response2.text()
	t.true(countRows(page2) < 20)
	t.false(page2.includes('file-24.md') && page2.includes('file-00.md'))

	// Out-of-range pages clamp instead of erroring
	const clamped = await fetch(`${base}/?page=99`)
	t.is(clamped.status, 200)

	for (const id of ids) {
		registry.unregister(id)
	}
})
