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

test.serial('sibling markdown under the same root renders without comment UI', async t => {
	const {reg} = registry.register(path.join(fixtureDir, 'doc.md'))
	const response = await fetch(`${base}/f/${reg.id}/sub/nested.md`)
	t.is(response.status, 200)
	const html = await response.text()
	t.true(html.includes('Nested'))
	t.false(html.includes('window.__marker'))
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
