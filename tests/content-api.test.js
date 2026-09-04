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
	fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-content-'))

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

const api = async (method, urlPath, body) => {
	const response = await fetch(`${base}/api${urlPath}`, {
		method,
		headers: body ? {'content-type': 'application/json'} : undefined,
		body: body ? JSON.stringify(body) : undefined
	})

	let data = null
	if (response.status !== 204) {
		data = await response.json()
	}

	return {status: response.status, data}
}

// A fixture of its own per test, so one write cannot disturb another
let seq = 0
const fixture = content => {
	const file = path.join(fixtureDir, `doc-${seq++}.md`)
	fs.writeFileSync(file, content)
	const {reg} = registry.register(file)
	return {id: reg.id, file, read: () => fs.readFileSync(file, 'utf8')}
}

test.serial('replacing a line writes the file and reports the new range', async t => {
	const doc = fixture('one\ntwo\nthree\n')

	const res = await api('PATCH', `/files/${doc.id}/content`, {
		lineStart: 2, lineEnd: 2, base: 'two', text: 'TWO\nEXTRA'
	})

	t.is(res.status, 200)
	// The range as written: one line in, two lines out
	t.is(res.data.lineStart, 2)
	t.is(res.data.lineEnd, 3)
	t.is(doc.read(), 'one\nTWO\nEXTRA\nthree\n')
})

test.serial('the final newline survives, and its absence does too', async t => {
	const withNewline = fixture('a\nb\n')
	await api('PATCH', `/files/${withNewline.id}/content`, {
		lineStart: 1, lineEnd: 1, base: 'a', text: 'A'
	})
	t.is(withNewline.read(), 'A\nb\n')

	const without = fixture('a\nb')
	await api('PATCH', `/files/${without.id}/content`, {
		lineStart: 1, lineEnd: 1, base: 'a', text: 'A'
	})
	t.is(without.read(), 'A\nb')
})

// Line numbers go stale the moment anything else edits the file, so the base
// text is what locates the range — the same rule getThreads re-anchors by.
test.serial('an edit above the range does not misplace the write', async t => {
	const doc = fixture('one\ntwo\nthree\n')
	fs.writeFileSync(doc.file, 'zero\none\ntwo\nthree\n')

	const res = await api('PATCH', `/files/${doc.id}/content`, {
		lineStart: 2, lineEnd: 2, base: 'two', text: 'TWO'
	})

	t.is(res.status, 200)
	t.is(res.data.lineStart, 3)
	t.is(doc.read(), 'zero\none\nTWO\nthree\n')
})

test.serial('a base that has gone is refused, with what is there now', async t => {
	const doc = fixture('one\ntwo\nthree\n')
	fs.writeFileSync(doc.file, 'one\nrewritten by someone else\nthree\n')

	const res = await api('PATCH', `/files/${doc.id}/content`, {
		lineStart: 2, lineEnd: 2, base: 'two', text: 'TWO'
	})

	t.is(res.status, 409)
	t.is(res.data.error.code, 'stale-content')
	t.is(res.data.current, 'rewritten by someone else')
	t.is(res.data.content, 'one\nrewritten by someone else\nthree\n')
	// Nothing was written
	t.is(doc.read(), 'one\nrewritten by someone else\nthree\n')
})

test.serial('force overwrites the line numbers as given', async t => {
	const doc = fixture('one\ntwo\nthree\n')
	fs.writeFileSync(doc.file, 'one\nrewritten by someone else\nthree\n')

	const res = await api('PATCH', `/files/${doc.id}/content`, {
		lineStart: 2, lineEnd: 2, base: 'two', text: 'TWO', force: true
	})

	t.is(res.status, 200)
	t.is(doc.read(), 'one\nTWO\nthree\n')
})

// Rewriting a CRLF file with bare newlines would make every snapshot in it
// stop matching verbatim, and every comment thread would report itself edited
test.serial('CRLF line endings are kept', async t => {
	const doc = fixture('one\r\ntwo\r\nthree\r\n')

	const res = await api('PATCH', `/files/${doc.id}/content`, {
		lineStart: 2, lineEnd: 2, base: 'two\r', text: 'TWO\nEXTRA'
	})

	t.is(res.status, 200)
	t.is(doc.read(), 'one\r\nTWO\r\nEXTRA\r\nthree\r\n')
})

test.serial('the temp file it writes through is not left behind', async t => {
	const doc = fixture('one\ntwo\n')
	await api('PATCH', `/files/${doc.id}/content`, {
		lineStart: 1, lineEnd: 1, base: 'one', text: 'ONE'
	})

	t.deepEqual(fs.readdirSync(fixtureDir).filter(name => name.includes('marker-tmp')), [])
})

test.serial('a comment in the edited range reports itself as changed', async t => {
	const doc = fixture('intro\ncommented line\ntail\n')
	const posted = await api('POST', `/files/${doc.id}/comments`, {
		line: 2, quote: 'commented line', body: 'why?', author: 'reviewer'
	})
	t.is(posted.status, 201)

	await api('PATCH', `/files/${doc.id}/content`, {
		lineStart: 2, lineEnd: 2, base: 'commented line', text: 'edited line'
	})

	const threads = await api('GET', `/files/${doc.id}/comments`)
	t.true(threads.data.threads[0].changed)
	t.is(threads.data.threads[0].currentText, 'edited line')
})

test.serial('an edit outside a comment re-anchors it silently', async t => {
	const doc = fixture('intro\ncommented line\ntail\n')
	await api('POST', `/files/${doc.id}/comments`, {
		line: 2, quote: 'commented line', body: 'why?', author: 'reviewer'
	})

	await api('PATCH', `/files/${doc.id}/content`, {
		lineStart: 1, lineEnd: 1, base: 'intro', text: 'intro\nsecond intro line'
	})

	const threads = await api('GET', `/files/${doc.id}/comments`)
	t.false(threads.data.threads[0].changed)
	// Moved down a line, and says so
	t.is(threads.data.threads[0].lineStart, 3)
})

test.serial('the body is validated', async t => {
	const doc = fixture('one\n')

	const cases = [
		{body: {lineEnd: 1, base: '', text: ''}, code: 'invalid-line-start'},
		{
			body: {
				lineStart: 0, lineEnd: 1, base: '', text: ''
			}, code: 'invalid-line-start'
		},
		{
			body: {
				lineStart: 2, lineEnd: 1, base: '', text: ''
			}, code: 'invalid-line-end'
		},
		{body: {lineStart: 1, lineEnd: 1, text: ''}, code: 'missing-base'},
		{body: {lineStart: 1, lineEnd: 1, base: ''}, code: 'missing-text'}
	]

	const results = await Promise.all(cases.map(
		one => api('PATCH', `/files/${doc.id}/content`, one.body)))

	for (const [i, res] of results.entries()) {
		t.is(res.status, 400)
		t.is(res.data.error.code, cases[i].code)
	}

	t.is(doc.read(), 'one\n')
})

test.serial('unknown ids and directories are refused', async t => {
	const missing = await api('PATCH', '/files/deadbeef00/content', {
		lineStart: 1, lineEnd: 1, base: '', text: ''
	})
	t.is(missing.status, 404)
	t.is(missing.data.error.code, 'not-registered')

	const {reg} = registry.register(fixtureDir)
	const dir = await api('PATCH', `/files/${reg.id}/content`, {
		lineStart: 1, lineEnd: 1, base: '', text: ''
	})
	t.is(dir.status, 400)
	t.is(dir.data.error.code, 'not-a-file')
})
