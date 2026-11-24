'use strict'

const crypto = require('node:crypto')
const path = require('node:path')

// The daemon answers to whoever can reach its port, and a web page the user
// happens to have open is one of those: it can send requests to localhost, and
// with DNS rebinding it can make its own hostname resolve to 127.0.0.1 and read
// the answers too. Everything here decides which requests are the user's own —
// the CLI, the skills' curl calls, and pages this daemon served.

// Addresses that mean "every interface" name no host a request could carry
const WILDCARDS = new Set(['', '0.0.0.0', '::', '[::]'])

const bare = host => host.toLowerCase().replace(/^\[(.*)]$/, '$1')

// The hostnames a request may name in its Host header. A rebinding attack
// arrives under the attacker's own name, so the loopback names are the whole
// list, plus whatever address the daemon was explicitly told to bind
const allowedHostnames = flags => {
	const names = new Set(['localhost', '127.0.0.1', '::1'])
	const address = bare(String(flags.address || ''))
	if (!WILDCARDS.has(address)) {
		names.add(address)
	}

	return names
}

// Host or Origin header → its bare hostname, or null when it does not parse
const hostnameOf = value => {
	try {
		return bare(new URL(value).hostname)
	} catch {
		return null
	}
}

const hostAllowed = (req, flags) => {
	const {host} = req.headers
	// HTTP/1.0 clients may omit it; a browser never does, so a rebinding
	// attack always carries one
	if (host === undefined) {
		return true
	}

	const name = hostnameOf('http://' + host)
	return name !== null && allowedHostnames(flags).has(name)
}

// Pages this daemon served, which are the only pages allowed to change its
// state. Browsers send Origin on every cross-origin request and on every
// same-origin request that is not a GET or HEAD; the CLI, curl and
// scripts/marker-state.js send none at all, which is what lets them through.
const originAllowed = (req, flags, port) => {
	const {origin} = req.headers
	if (origin === undefined) {
		return true
	}

	let url
	try {
		url = new URL(origin)
	} catch {
		// Includes "null", which sandboxed frames and file: pages send
		return false
	}

	return url.protocol === 'http:' &&
		Number(url.port || 80) === Number(port) &&
		allowedHostnames(flags).has(bare(url.hostname))
}

const refuse = (res, status, code, message, json) => {
	if (json) {
		res.writeHead(status, {'content-type': 'application/json; charset=utf-8'})
		res.end(JSON.stringify({error: {code, message}}))
		return
	}

	res.writeHead(status, {'content-type': 'text/plain; charset=utf-8'})
	res.end(message + '\n')
}

// First in the middleware stack: every response carries the headers that cost
// nothing, and a request naming a host that is not this machine goes no
// further
const createRequestGuard = flags => (req, res, next) => {
	res.setHeader('X-Content-Type-Options', 'nosniff')
	// A document's external images would otherwise learn the /f/<id>/<name>
	// URL it was read under
	res.setHeader('Referrer-Policy', 'same-origin')

	if (!hostAllowed(req, flags)) {
		return refuse(res, 403, 'forbidden-host',
			`Host "${req.headers.host}" is not this daemon — use http://localhost:${flags.$httpPort}/` +
			' (or pass the address you reach it by as --address)')
	}

	next()
}

const SAFE_METHODS = new Set(['GET', 'HEAD'])

// In front of /api. A request from another origin is refused whatever it asks,
// and one that changes state is also refused when it is a navigation: that is
// what a <form> post is, and a same-origin page carrying a document's raw HTML
// could otherwise post one at /api/shutdown with a click.
const createApiGuard = flags => (req, res, next) => {
	res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')

	if (!originAllowed(req, flags, flags.$httpPort)) {
		return refuse(res, 403, 'forbidden-origin',
			`Requests from ${req.headers.origin} are not accepted`, true)
	}

	if (!SAFE_METHODS.has(req.method) && req.headers['sec-fetch-mode'] === 'navigate') {
		return refuse(res, 403, 'forbidden-navigation',
			'The API does not accept form submissions', true)
	}

	next()
}

// A WebSocket handshake is not subject to the same-origin policy at all, so a
// page anywhere could otherwise open one and be sent every re-rendered document
const upgradeAllowed = (req, flags) =>
	hostAllowed(req, flags) && originAllowed(req, flags, flags.$httpPort)

const newNonce = () => crypto.randomBytes(16).toString('hex')

// The policy for a page this daemon renders. Raw HTML in markdown is passed
// through (html: true), so without this a document could run script on the
// daemon's origin and use the API from there — register a home directory and
// read it back, or write to any registered file. Only scripts carrying this
// response's nonce run; 'strict-dynamic' extends that to the scripts they load
// (the mermaid bundle, MathJax's own components), and markup injected later by
// hot reload never carries the nonce. Styles are left alone: mermaid and
// MathJax both write inline ones, and a style cannot reach the API.
//
// No other site may frame a page either: a framed page can be dressed up so
// that a click meant for the attacker's page lands on Apply or Delete.
const pagePolicy = nonce => [
	`script-src 'nonce-${nonce}' 'strict-dynamic'`,
	'object-src \'none\'',
	'base-uri \'none\'',
	'frame-ancestors \'self\''
].join('; ')

// Files served as they are — an .html or .svg next to the document, say —
// render in an opaque origin of their own. Their scripts still run, but as a
// stranger to the daemon: the API refuses their Origin of "null" and the
// same-origin policy keeps them from reading anything back.
// A document may still embed one in an <iframe>, which is why frame-ancestors
// is 'self' rather than 'none'.
const RAW_FILE_POLICY = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; ' +
	'frame-ancestors \'self\''

// Names under a served root that are never served, listed or rendered. A
// registration hands out everything beside the file, and a document kept in a
// home directory or a repository sits next to keys, cloud credentials and a
// .git holding every remote's URL and token. Only names that are secrets by
// convention are here, so .github — where README images live — .vscode,
// .claude and the rest stay servable. Compared lowercased, since the default
// macOS file system would serve .SSH as .ssh.
const SECRET_DIRS = new Set([
	'.ssh',
	'.gnupg',
	'.aws',
	'.azure',
	'.kube',
	'.docker',
	'.config',
	'.git',
	'.password-store'
])

const SECRET_FILES = new Set([
	'.npmrc',
	'.netrc',
	'.pgpass',
	'.pypirc',
	'.git-credentials',
	'.htpasswd'
])

const SECRET_PATTERNS = [
	// .env, .env.local, .env.production …
	/^\.env(\..+)?$/,
	// OpenSSH private keys; their .pub halves are public and stay servable
	/^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/,
	// Containers that usually hold a private key
	/\.(pem|p12|pfx)$/
]

const isSecretName = name => {
	const lower = name.toLowerCase()
	return SECRET_DIRS.has(lower) || SECRET_FILES.has(lower) ||
		SECRET_PATTERNS.some(pattern => pattern.test(lower))
}

// Whether any segment of target below root is a secret's name. Only the part
// below the served root counts: a folder registered from inside ~/.config, or
// ~/.ssh itself, was named by the user, and so was a registered file.
const isSecretPath = (root, target) => path.relative(root, target)
	.split(path.sep)
	.some(segment => segment !== '' && segment !== '..' && isSecretName(segment))

module.exports = {
	allowedHostnames,
	hostAllowed,
	originAllowed,
	upgradeAllowed,
	createRequestGuard,
	createApiGuard,
	newNonce,
	pagePolicy,
	RAW_FILE_POLICY,
	isSecretName,
	isSecretPath
}
