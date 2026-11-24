'use strict'

const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const {spawn} = require('node:child_process')
const test = require('ava')
const getPort = require('get-port')

const server = require('../lib/server')
const registry = require('../lib/registry')

// Two daemons in one process share the registry singleton, which is what
// lets one registration be read through both: the default one and one
// started with --follow-symlinks
let service
let port
let following
let followingPort
let fixtureDir
let outsideDir

const write = (relPath, content) => {
	const target = path.join(fixtureDir, relPath)
	fs.mkdirSync(path.dirname(target), {recursive: true})
	fs.writeFileSync(target, content)
}

test.before(async () => {
	fixtureDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marker-serving-')))
	outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marker-outside-')))

	write('doc.md', '# Doc\n\nText.\n')
	write('.ssh/x', 'SECRET-SSH\n')
	write('.git/config', 'SECRET-GIT\n')
	write('.aws/credentials', 'SECRET-AWS\n')
	write('.env', 'SECRET-ENV\n')
	write('.env.local', 'SECRET-ENV-LOCAL\n')
	write('.npmrc', 'SECRET-NPMRC\n')
	write('id_rsa', 'SECRET-KEY\n')
	write('id_rsa.pub', 'ssh-rsa PUBLIC\n')
	write('server.pem', 'SECRET-PEM\n')
	write('.github/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n')
	write('.vscode/notes.md', '# Notes\n')
	write('.config/app/notes.md', '# App notes\n')
	write('script.js', 'console.log(1)\n')
	write('change.diff', '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')
	write('math.md', '# Math\n\n\\(x^2\\)\n')

	fs.writeFileSync(path.join(outsideDir, 'secret.md'), '# OUTSIDE\n')
	fs.symlinkSync(path.join(outsideDir, 'secret.md'), path.join(fixtureDir, 'escape.md'))
	fs.symlinkSync(outsideDir, path.join(fixtureDir, 'escape-dir'))
	fs.symlinkSync(path.join(fixtureDir, 'doc.md'), path.join(fixtureDir, 'alias.md'))
	fs.symlinkSync(path.join(fixtureDir, '.git', 'config'), path.join(fixtureDir, 'innocent.txt'))

	port = await getPort()
	service = await server.init({
		port, address: 'localhost', silent: true, hotreload: false, theme: 'dark'
	})

	followingPort = await getPort()
	following = await server.init({
		port: followingPort,
		address: 'localhost',
		silent: true,
		hotreload: false,
		theme: 'dark',
		followSymlinks: true
	})
})

test.after.always(() => {
	registry.reset()
	for (const each of [service, following]) {
		if (each) {
			each.close()
		}
	}
})

const get = (urlPath, {host = '127.0.0.1', to = port, family} = {}) => new Promise((resolve, reject) => {
	const request = http.get({
		host, port: to, path: urlPath, family
	}, res => {
		let data = ''
		res.on('data', chunk => {
			data += chunk
		})
		res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: data}))
	})
	request.on('error', reject)
})

const statusOf = async (urlPath, options) => {
	const response = await get(urlPath, options)
	return response.status
}

const healthOf = async options => {
	const response = await get('/api/health', options)
	return JSON.parse(response.body)
}

const dirReg = () => registry.register(fixtureDir).reg

// The message an error page shows
const errorOf = html => (html.match(/<p class="errorMsg">[\s\S]*?<\/p>/) || [''])[0]

/* ---------- D2: secrets under a served root ---------- */

test.serial('secret dot-paths under a served root are not found', async t => {
	const reg = dirReg()
	const missing = await get(`${reg.urlPath}no-such-file`)
	t.is(missing.status, 404)

	for (const name of ['.ssh/x',
		'.ssh/',
		'.git/config',
		'.aws/credentials',
		'.env',
		'.env.local',
		'.npmrc',
		'id_rsa',
		'server.pem',
		'.SSH/x']) {
		const response = await get(reg.urlPath + name)
		t.is(response.status, 404, `${name}`)
		t.false(response.body.includes('SECRET'), `${name}`)
		// The error reads exactly as a missing file's does, bar the path
		t.is(errorOf(response.body).replaceAll(path.resolve(fixtureDir, `${name}`), 'P'),
			errorOf(missing.body).replaceAll(path.join(fixtureDir, 'no-such-file'), 'P'), `${name}`)
	}
})

test.serial('a registration of a file still refuses its secret siblings', async t => {
	const {reg} = registry.register(path.join(fixtureDir, 'doc.md'))
	const prefix = reg.urlPath.replace(/[^/]+$/, '')
	t.is(await statusOf(prefix + '.ssh/x'), 404)
	t.is(await statusOf(prefix + 'id_rsa'), 404)
})

test.serial('dot-paths that are not secrets stay servable', async t => {
	const reg = dirReg()
	for (const name of ['.github/logo.svg', '.vscode/notes.md', 'id_rsa.pub', 'doc.md']) {
		t.is(await statusOf(reg.urlPath + name), 200, `${name}`)
	}
})

test.serial('the folder listing hides secrets', async t => {
	const response = await get(dirReg().urlPath)
	t.is(response.status, 200)
	t.true(response.body.includes('doc.md'))
	t.true(response.body.includes('id_rsa.pub'))
	t.false(response.body.includes('>id_rsa<'))
	t.false(response.body.includes('server.pem'))
})

test.serial('a file the user registered is served even when its name is a secret', async t => {
	const {reg} = registry.register(path.join(fixtureDir, '.env'))
	const own = await get(reg.urlPath)
	t.is(own.status, 200)
	t.true(own.body.includes('SECRET-ENV'))
	t.is(await statusOf(reg.urlPath.replace(/[^/]+$/, '.env.local')), 404)
})

test.serial('a folder registered from inside a secret directory is served', async t => {
	const {reg} = registry.register(path.join(fixtureDir, '.config', 'app'))
	t.is(await statusOf(reg.urlPath + 'notes.md'), 200)
})

/* ---------- D3: symlinks out of the served root ---------- */

test.serial('a symlink out of the served root is refused', async t => {
	const reg = dirReg()
	for (const name of ['escape.md', 'escape-dir/secret.md', 'escape-dir/']) {
		const response = await get(reg.urlPath + name)
		t.is(response.status, 403, `${name}`)
		t.false(response.body.includes('OUTSIDE'), `${name}`)
		t.true(response.body.includes('--follow-symlinks'), `${name}`)
	}
})

test.serial('a symlink that stays inside the root works, unless it leads to a secret', async t => {
	const reg = dirReg()
	const alias = await get(reg.urlPath + 'alias.md')
	t.is(alias.status, 200)
	t.true(alias.body.includes('Doc'))

	const innocent = await get(reg.urlPath + 'innocent.txt')
	t.is(innocent.status, 404)
	t.false(innocent.body.includes('SECRET'))
})

test.serial('--follow-symlinks serves what a symlink points to, still not a secret', async t => {
	const reg = dirReg()
	const response = await get(reg.urlPath + 'escape.md', {to: followingPort})
	t.is(response.status, 200)
	t.true(response.body.includes('OUTSIDE'))
	t.is(await statusOf(reg.urlPath + 'innocent.txt', {to: followingPort}), 404)

	const health = await healthOf({to: followingPort})
	t.true(health.followSymlinks)
	const defaults = await healthOf()
	t.false(defaults.followSymlinks)
})

/* ---------- D4: framing ---------- */

test.serial('no other site may frame a page or a raw file', async t => {
	const reg = dirReg()
	for (const name of ['doc.md', '.github/logo.svg', '']) {
		const response = await get(reg.urlPath + name)
		t.regex(response.headers['content-security-policy'], /frame-ancestors 'self'/, `${name || 'listing'}`)
	}

	const index = await get('/')
	t.regex(index.headers['content-security-policy'], /frame-ancestors 'self'/)
})

/* ---------- D5: MathJax is served by the daemon ---------- */

test.serial('MathJax and what it loads at runtime come from the daemon', async t => {
	const page = await get(dirReg().urlPath + 'math.md')
	t.false(page.body.includes('cdn.jsdelivr.net'))
	t.regex(page.body, /<script nonce="[^"]+" type="text\/javascript" id="MathJax-script" async\s+src="{markserv}vendor\/mathjax\/tex-mml-chtml\.js"><\/script>/)

	for (const asset of ['tex-mml-chtml.js',
		'output/chtml/fonts/woff-v2/MathJax_Main-Regular.woff',
		'input/tex/extensions/color.js']) {
		const response = await get('/%7Bmarkserv%7Dvendor/mathjax/' + asset)
		t.is(response.status, 200, `${asset}`)
	}
})

/* ---------- D6: only documents are editable ---------- */

const patch = (id, body) => fetch(`http://127.0.0.1:${port}/api/files/${id}/content`, {
	method: 'PATCH',
	headers: {'content-type': 'application/json'},
	body: JSON.stringify(body)
})

test.serial('an edit to a file that is not a document is refused', async t => {
	const target = path.join(fixtureDir, 'script.js')
	const {reg} = registry.register(target)
	const response = await patch(reg.id, {
		lineStart: 1, lineEnd: 1, base: 'console.log(1)', text: 'evil()'
	})
	t.is(response.status, 403)
	const {error} = await response.json()
	t.is(error.code, 'not-editable')
	t.is(fs.readFileSync(target, 'utf8'), 'console.log(1)\n')
})

test.serial('markdown and diff files stay editable', async t => {
	const diff = registry.register(path.join(fixtureDir, 'change.diff')).reg
	const response = await patch(diff.id, {
		lineStart: 5, lineEnd: 5, base: '+b', text: '+c'
	})
	t.is(response.status, 200)
	t.true(fs.readFileSync(diff.path, 'utf8').includes('+c\n'))

	const doc = registry.register(path.join(fixtureDir, 'math.md')).reg
	const edited = await patch(doc.id, {
		lineStart: 1, lineEnd: 1, base: '# Math', text: '# Maths'
	})
	t.is(edited.status, 200)
})

/* ---------- P1: both loopback addresses ---------- */

const hasIPv6 = () => new Promise(resolve => {
	const probe = net.createServer()
	probe.once('error', () => resolve(false))
	probe.listen(0, '::1', () => probe.close(() => resolve(true)))
})

test.serial('the daemon answers on 127.0.0.1, on ::1 and as localhost', async t => {
	t.is(await statusOf('/api/health', {host: '127.0.0.1'}), 200)
	t.is(await statusOf('/api/health', {host: 'localhost', family: 4}), 200)
	if (await hasIPv6()) {
		t.is(await statusOf('/api/health', {host: '::1'}), 200)
		t.is(await statusOf('/api/health', {host: 'localhost', family: 6}), 200)
	}

	t.is(service.httpServers.length, (await hasIPv6()) ? 2 : 1)
})

const runNode = (args, timeoutMs = 10_000) => new Promise((resolve, reject) => {
	const child = spawn(process.execPath, args, {stdio: ['ignore', 'pipe', 'pipe']})
	let stdout = ''
	child.stdout.on('data', chunk => {
		stdout += chunk
	})
	const timer = setTimeout(() => {
		child.kill()
		reject(new Error('timed out'))
	}, timeoutMs)
	child.on('exit', code => {
		clearTimeout(timer)
		resolve({code, stdout})
	})
})

const daemonJs = path.join(__dirname, '..', 'lib', 'daemon.js')
const cliJs = path.join(__dirname, '..', 'lib', 'cli.js')

test.serial('a daemon losing the race to one of ours exits quietly', async t => {
	const {code} = await runNode([daemonJs, '--port', String(port), '--no-hotreload', '--silent'])
	t.is(code, 0)
})

test.serial('a daemon finding the port taken by something else fails', async t => {
	const otherPort = await getPort()
	const other = http.createServer((req, res) => {
		res.writeHead(404)
		res.end()
	})
	await new Promise(resolve => {
		other.listen(otherPort, '127.0.0.1', resolve)
	})

	try {
		const {code} = await runNode([daemonJs, '--port', String(otherPort), '--no-hotreload', '--silent'])
		t.is(code, 1)
	} finally {
		other.close()
	}
})

test.serial('the CLI finds the daemon by its health check', async t => {
	const {code, stdout} = await runNode([cliJs, 'status', '--json', '--port', String(port)])
	t.is(code, 0)
	const status = JSON.parse(stdout)
	t.true(status.running)
	t.is(status.port, port)
})
