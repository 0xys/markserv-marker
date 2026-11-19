'use strict'

const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('ava')
const getPort = require('get-port')
const WebSocket = require('ws')

const server = require('../lib/server')
const registry = require('../lib/registry')

let service
let port
let fixtureDir

test.before(async () => {
	fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-security-'))
	fs.writeFileSync(path.join(fixtureDir, 'doc.md'),
		'# Doc\n\n<script>window.injected = true</script>\n\nText.\n')
	fs.writeFileSync(path.join(fixtureDir, 'page.html'), '<p>raw</p>\n')
	fs.writeFileSync(path.join(fixtureDir, 'pic.svg'),
		'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n')

	port = await getPort()
	service = await server.init({
		port,
		address: 'localhost',
		silent: true,
		hotreload: true,
		theme: 'dark'
	})
})

test.after.always(() => {
	registry.reset()
	if (service) {
		service.close()
	}
})

// Node's fetch will not let a caller choose the Host header, which is the
// whole point of a rebinding test, so these go through http.request
const raw = (method, urlPath, headers = {}, body = null) => new Promise((resolve, reject) => {
	const request = http.request({
		host: 'localhost', port, method, path: urlPath, headers
	}, res => {
		let data = ''
		res.on('data', chunk => {
			data += chunk
		})
		res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: data}))
	})
	request.on('error', reject)
	if (body !== null) {
		request.write(body)
	}

	request.end()
})

const json = {'content-type': 'application/json'}
const docPath = () => path.join(fixtureDir, 'doc.md')

const settle = ms => new Promise(resolve => {
	setTimeout(resolve, ms)
})

/* ---------- Host header (DNS rebinding) ---------- */

test.serial('a request naming a foreign host is refused everywhere', async t => {
	const {reg} = registry.register(docPath())
	for (const urlPath of ['/', '/api/health', '/api/files', reg.urlPath]) {
		const response = await raw('GET', urlPath, {host: `attacker.example:${port}`})
		t.is(response.status, 403, `${urlPath}`)
		t.false(response.body.includes('Doc'), `${urlPath}`)
	}

	const write = await raw('POST', '/api/files', {...json, host: 'attacker.example'},
		JSON.stringify({path: os.homedir()}))
	t.is(write.status, 403)
	t.false(registry.list().some(item => item.path === fs.realpathSync(os.homedir())))
})

test.serial('the loopback names are all accepted as the host', async t => {
	for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, 'localhost']) {
		const response = await raw('GET', '/api/health', {host})
		t.is(response.status, 200, `${host}`)
	}
})

test.serial('a host that merely starts like a loopback name is refused', async t => {
	for (const host of ['localhost.attacker.example', '127.0.0.1.nip.io', 'localhost@attacker.example']) {
		const response = await raw('GET', '/api/health', {host})
		t.is(response.status, 403, `${host}`)
	}
})

/* ---------- Origin, form posts and content types (CSRF) ---------- */

test.serial('the API refuses requests from another origin', async t => {
	const body = JSON.stringify({path: docPath()})
	for (const origin of ['http://attacker.example', 'null', `http://localhost:${port + 1}`, `https://localhost:${port}`]) {
		const post = await raw('POST', '/api/files', {...json, origin}, body)
		t.is(post.status, 403, `${origin}`)
		t.is(JSON.parse(post.body).error.code, 'forbidden-origin')
	}

	const shutdown = await raw('POST', '/api/shutdown', {origin: 'http://attacker.example'})
	t.is(shutdown.status, 403)

	const read = await raw('GET', '/api/files', {origin: 'http://attacker.example'})
	t.is(read.status, 403)
})

test.serial('the API accepts the daemon\'s own pages and clients sending no Origin', async t => {
	const body = JSON.stringify({path: docPath()})
	for (const origin of [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]) {
		const post = await raw('POST', '/api/files', {...json, origin}, body)
		t.is(post.status, 200, `${origin}`)
	}

	// The CLI, curl and scripts/marker-state.js send no Origin at all
	const cli = await raw('POST', '/api/files', json, body)
	t.is(cli.status, 200)
})

test.serial('a form post at the API is refused even from the same origin', async t => {
	const response = await raw('POST', '/api/shutdown', {
		origin: `http://localhost:${port}`,
		'sec-fetch-mode': 'navigate',
		'content-type': 'application/x-www-form-urlencoded'
	}, 'a=b')
	t.is(response.status, 403)
	t.is(JSON.parse(response.body).error.code, 'forbidden-navigation')
})

test.serial('a body that is not declared as JSON is refused', async t => {
	const body = JSON.stringify({path: os.homedir()})
	for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', null]) {
		const headers = contentType ? {'content-type': contentType} : {}
		const response = await raw('POST', '/api/files', headers, body)
		t.is(response.status, 415, `${contentType}`)
	}

	t.false(registry.list().some(item => item.path === fs.realpathSync(os.homedir())))

	const charset = await raw('POST', '/api/files',
		{'content-type': 'application/json; charset=utf-8'}, JSON.stringify({path: docPath()}))
	t.is(charset.status, 200)
})

test.serial('the API answers no preflight, so no other origin is ever let in', async t => {
	const response = await raw('OPTIONS', '/api/files/x/content', {
		origin: 'http://attacker.example',
		'access-control-request-method': 'PATCH'
	})
	t.not(response.status, 204)
	t.is(response.headers['access-control-allow-origin'], undefined)
})

/* ---------- Response headers ---------- */

test.serial('a rendered page allows only scripts carrying its own nonce', async t => {
	const {reg} = registry.register(docPath())
	const first = await raw('GET', reg.urlPath)
	const second = await raw('GET', reg.urlPath)
	t.is(first.status, 200)

	const policy = first.headers['content-security-policy']
	const nonce = policy.match(/'nonce-([^']+)'/)[1]
	t.regex(policy, /'strict-dynamic'/)
	t.regex(policy, /object-src 'none'/)
	t.regex(policy, /base-uri 'none'/)
	t.not(second.headers['content-security-policy'], policy)

	const scripts = first.body.match(/<script\b[^>]*>/g)
	const ours = scripts.filter(tag => tag.includes(`nonce="${nonce}"`))
	// Every script the template carries has it; the one in the document does not
	t.is(ours.length, scripts.length - 1)
	t.true(scripts.includes('<script>'))
	t.is(first.headers['x-content-type-options'], 'nosniff')
	t.is(first.headers['referrer-policy'], 'same-origin')
})

test.serial('the index, folder and error pages carry a nonce policy too', async t => {
	const {reg} = registry.register(fixtureDir)
	for (const urlPath of ['/', reg.urlPath, '/nowhere']) {
		const response = await raw('GET', `${urlPath}`)
		const nonce = response.headers['content-security-policy'].match(/'nonce-([^']+)'/)[1]
		const scripts = response.body.match(/<script\b[^>]*>/g) || []
		t.true(scripts.every(tag => tag.includes(`nonce="${nonce}"`)), `${urlPath}`)
	}
})

test.serial('files served as they are run sandboxed, away from the daemon\'s origin', async t => {
	const {reg} = registry.register(docPath())
	const prefix = reg.urlPath.replace(/[^/]+$/, '')
	for (const name of ['page.html', 'pic.svg']) {
		const response = await raw('GET', prefix + name)
		t.is(response.status, 200, `${name}`)
		t.regex(response.headers['content-security-policy'], /^sandbox\b/, `${name}`)
		t.notRegex(response.headers['content-security-policy'], /allow-same-origin/, `${name}`)
	}
})

test.serial('API responses cannot be embedded by another origin', async t => {
	const response = await raw('GET', '/api/health')
	t.is(response.headers['cross-origin-resource-policy'], 'same-origin')
})

/* ---------- Markup in names ---------- */

test.serial('a file name carrying markup is escaped in the folder listing', async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-names-'))
	const evil = '<img src=x onerror=alert(1)>.md'
	fs.writeFileSync(path.join(dir, evil), '# x\n')
	fs.mkdirSync(path.join(dir, '"><b>dir'))
	const {reg} = registry.register(dir)

	const response = await raw('GET', reg.urlPath)
	t.is(response.status, 200)
	t.false(response.body.includes('<img src=x'))
	t.false(response.body.includes('"><b>'))
	t.true(response.body.includes('&lt;img src=x onerror=alert(1)&gt;.md'))
	t.true(response.body.includes(`href="${encodeURIComponent(evil)}"`))
})

test.serial('a malformed escape in a URL is a 400, not a stack trace', async t => {
	const {reg} = registry.register(docPath())
	const response = await raw('GET', `/f/${reg.id}/%E0%A4%A`)
	t.is(response.status, 400)
	t.false(response.body.includes('at '))

	const asset = await raw('GET', '/%7Bmarkserv%7Dtemplates/%E0%A4%A')
	t.is(asset.status, 403)
})

test.serial('an error page carries its message but no stack trace', async t => {
	const response = await raw('GET', '/f/0000000000/x.md')
	t.is(response.status, 404)
	t.true(response.body.includes('class="errorMsg"'))
	t.false(response.body.includes('<pre>'))
	t.false(response.body.includes(__dirname.split('/tests')[0]))
	t.notRegex(response.body, /\n\s+at /)
})

/* ---------- The hot-reload socket ---------- */

const connect = (headers = {}, host = '127.0.0.1') => new Promise(resolve => {
	const url = host.includes(':') ? `ws://[${host}]:${service.wsPort}` : `ws://${host}:${service.wsPort}`
	const ws = new WebSocket(url, {headers, handshakeTimeout: 2000})
	ws.on('open', () => {
		ws.close()
		resolve('open')
	})
	ws.on('unexpected-response', (request, response) => {
		resolve(response.statusCode)
	})
	ws.on('error', error => resolve(error.code || error.message))
})

test.serial('the hot-reload socket refuses pages from other origins', async t => {
	t.is(await connect({origin: 'http://attacker.example'}), 403)
	t.is(await connect({origin: 'null'}), 403)
	t.is(await connect({host: 'attacker.example'}), 403)
})

test.serial('the hot-reload socket accepts the daemon\'s pages on either loopback address', async t => {
	t.is(await connect({origin: `http://localhost:${port}`}), 'open')
	t.is(await connect({origin: `http://127.0.0.1:${port}`}), 'open')
	t.is(await connect({}), 'open')
	t.is(await connect({origin: `http://localhost:${port}`}, '::1'), 'open')
})

test.serial('the hot-reload socket is not reachable on a network address', async t => {
	const external = Object.values(os.networkInterfaces()).flat()
		.find(item => item && item.family === 'IPv4' && !item.internal)
	if (!external) {
		t.pass('no non-loopback IPv4 interface on this machine')
		return
	}

	// Refused, or dropped by a firewall until the handshake times out
	t.not(await connect({}, external.address), 'open')
})

test.serial('a malformed page path sent over the socket does not take the daemon down', async t => {
	const file = path.join(fixtureDir, 'reload.md')
	fs.writeFileSync(file, '# v1\n')
	const {reg} = registry.register(file)
	const prefix = reg.urlPath.replace(/[^/]+$/, '')

	const bad = new WebSocket(`ws://127.0.0.1:${service.wsPort}`)
	await new Promise(resolve => {
		bad.on('open', resolve)
	})
	bad.send(JSON.stringify({path: prefix + '%E0%A4%A'}))

	const good = new WebSocket(`ws://127.0.0.1:${service.wsPort}`)
	const reloaded = new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('no reload')), 5000)
		good.on('message', data => {
			const message = JSON.parse(data)
			if (message.type === 'reload' && message.html.includes('v2')) {
				clearTimeout(timer)
				resolve(message)
			}
		})
	})
	good.on('open', () => good.send(JSON.stringify({path: reg.urlPath})))
	await settle(300)

	fs.writeFileSync(file, '# v2\n')
	t.truthy(await reloaded)
	bad.close()
	good.close()
})

test.serial('the socket drops a client sending an oversized message', async t => {
	const ws = new WebSocket(`ws://127.0.0.1:${service.wsPort}`)
	await new Promise(resolve => {
		ws.on('open', resolve)
	})
	const closed = new Promise(resolve => {
		ws.on('close', code => resolve(code))
	})
	ws.on('error', () => {})
	ws.send('x'.repeat(1024 * 1024))
	t.is(await closed, 1009)
	// And the daemon is still there to take the next one
	t.is(await connect({}), 'open')
})

test.serial('a malformed frame closes that socket and nothing else', async t => {
	const ws = new WebSocket(`ws://127.0.0.1:${service.wsPort}`)
	await new Promise(resolve => {
		ws.on('open', resolve)
	})
	const closed = new Promise(resolve => {
		ws.on('close', resolve)
	})
	ws.on('error', () => {})
	// An unmasked frame with a reserved opcode: a protocol error on two counts
	ws._socket.write(Buffer.from([0x83, 0x00]))
	await closed
	t.is(await connect({}), 'open')
})

/* ---------- Writing a document ---------- */

test.serial('an edit never writes through a file planted where the temp file goes', async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-plant-'))
	const file = path.join(dir, 'doc.md')
	const victim = path.join(dir, 'victim.txt')
	fs.writeFileSync(file, 'one\ntwo\n')
	fs.writeFileSync(victim, 'untouched\n')
	// The name the temp file used to have, pointing somewhere else
	fs.symlinkSync(victim, path.join(dir, '.doc.md.marker-tmp'))
	fs.chmodSync(file, 0o600)
	const {reg} = registry.register(file)

	const response = await raw('PATCH', `/api/files/${reg.id}/content`, json,
		JSON.stringify({
			lineStart: 1, lineEnd: 1, base: 'one', text: 'ONE'
		}))
	t.is(response.status, 200)
	t.is(fs.readFileSync(file, 'utf8'), 'ONE\ntwo\n')
	t.is(fs.readFileSync(victim, 'utf8'), 'untouched\n')
	// The rename keeps the document's own permissions
	t.is(fs.statSync(file).mode % 4096, 0o600)
	t.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.marker-tmp')), ['.doc.md.marker-tmp'])
})
