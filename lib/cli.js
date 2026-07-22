#!/usr/bin/env node

'use strict'

const path = require('node:path')
const fs = require('node:fs')
const {spawn} = require('node:child_process')
const meow = require('meow')
const opn = require('open')
const chalk = require('chalk')

const cliDefs = require('./cli-defs')
const pkg = require('../package.json')

const cliHelp = String(fs.readFileSync(path.join(__dirname, 'cli-help.txt')))

const HEALTH_TIMEOUT_MS = 300
const DAEMON_START_TIMEOUT_MS = 5000
const DAEMON_POLL_INTERVAL_MS = 100

const info = (str, flags) => {
	if (!flags.silent && !flags.json) {
		console.error(chalk`{bgGreen.black   Marker  } ` + str)
	}
}

const fail = message => {
	console.error(chalk`{bgRed.white   Marker  } ` + message)
	process.exit(1)
}

const apiOrigin = flags => `http://${flags.address}:${flags.port}`

const fetchJson = async (url, options = {}, timeoutMs = HEALTH_TIMEOUT_MS) => {
	const response = await fetch(url, {
		...options,
		signal: AbortSignal.timeout(timeoutMs),
		headers: options.body ? {'content-type': 'application/json'} : undefined
	})

	let data = null
	try {
		data = await response.json()
	} catch {}

	return {status: response.status, data}
}

// Returns the daemon's health object, null if nothing listens on the port,
// or exits if the port is occupied by something that is not our daemon.
const checkHealth = async flags => {
	let result
	try {
		result = await fetchJson(`${apiOrigin(flags)}/api/health`)
	} catch {
		return null
	}

	if (result.data && result.data.name === pkg.name) {
		return result.data
	}

	fail(`port ${flags.port} is in use by another service — pass a different --port`)
}

const sleep = ms => new Promise(resolve => {
	setTimeout(resolve, ms)
})

const spawnDaemon = flags => {
	const args = [
		require.resolve('./daemon'),
		'--port',
		String(flags.port),
		'--address',
		flags.address,
		'--theme',
		flags.theme
	]

	if (flags.light) {
		args.push('--light')
	}

	if (flags.synthwave) {
		args.push('--synthwave')
	}

	if (!flags.hotreload) {
		args.push('--no-hotreload')
	}

	spawn(process.execPath, args, {
		detached: true,
		stdio: 'ignore'
	}).unref()
}

const ensureDaemon = async flags => {
	let health = await checkHealth(flags)
	if (health) {
		return health
	}

	info(`starting daemon on port ${flags.port}...`, flags)
	spawnDaemon(flags)

	const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
	while (Date.now() < deadline) {
		await sleep(DAEMON_POLL_INTERVAL_MS)
		health = await checkHealth(flags)
		if (health) {
			return health
		}
	}

	fail(`daemon did not start within ${DAEMON_START_TIMEOUT_MS / 1000}s — ` +
		'run "markserv-marker daemon" in the foreground to see its logs')
}

const registerPath = async (inputPath, flags) => {
	const absPath = path.resolve(process.cwd(), inputPath)

	try {
		fs.statSync(absPath)
	} catch {
		fail(`no such file or directory: ${absPath}`)
	}

	const health = await ensureDaemon(flags)

	const {status, data} = await fetchJson(`${apiOrigin(flags)}/api/files`, {
		method: 'POST',
		body: JSON.stringify({path: absPath})
	}, 3000)

	if (status !== 200 && status !== 201) {
		fail(`daemon rejected the registration: ${JSON.stringify(data)}`)
	}

	if (flags.json) {
		console.log(JSON.stringify({...data, daemonPid: health.pid, port: health.port}))
		return
	}

	info(`registered ${data.created ? '' : '(already) '}with daemon pid ${health.pid}`, flags)
	info(chalk`comments API: {grey ${apiOrigin(flags)}/api/files/${data.id}/comments}`, flags)
	console.log(data.url)

	if (flags.browser) {
		opn(data.url)
	}
}

const stopDaemon = async flags => {
	const health = await checkHealth(flags)
	if (!health) {
		fail(`no daemon running on port ${flags.port}`)
	}

	await fetchJson(`${apiOrigin(flags)}/api/shutdown`, {method: 'POST'}, 3000)

	if (flags.json) {
		console.log(JSON.stringify({stopped: true, pid: health.pid}))
	} else {
		info(`stopped daemon (pid ${health.pid})`, flags)
	}
}

const showStatus = async flags => {
	const health = await checkHealth(flags)
	if (!health) {
		if (flags.json) {
			console.log(JSON.stringify({running: false}))
			return
		}

		fail(`no daemon running on port ${flags.port}`)
	}

	const {data} = await fetchJson(`${apiOrigin(flags)}/api/files`, {}, 3000)

	if (flags.json) {
		console.log(JSON.stringify({running: true, ...health, files: data.files}))
		return
	}

	info(`daemon running: pid ${health.pid}, port ${health.port}, ` +
		`since ${health.startedAt}, index: ${apiOrigin(flags)}/`, flags)

	for (const file of data.files) {
		const badge = file.comments.total > 0 ?
			chalk` {yellow [${file.comments.unresolved}/${file.comments.total} comments]}` :
			''
		info(chalk`{cyan ${file.name}}${badge} {grey ${file.path}}`, flags)
		info(chalk`  {blueBright.underline ${file.url}}`, flags)
	}

	if (data.files.length === 0) {
		info(chalk`{grey no files registered yet}`, flags)
	}
}

const run = async opts => {
	const {flags} = opts
	const command = opts.input[0]

	if (command === 'daemon') {
		return require('./daemon').run(flags)
	}

	if (command === 'stop') {
		return stopDaemon(flags)
	}

	if (command === 'status' || command === 'list') {
		return showStatus(flags)
	}

	if (command) {
		return registerPath(command, flags)
	}

	// No arguments: show status when a daemon runs, otherwise the help text
	const health = await checkHealth(flags)
	if (health) {
		return showStatus(flags)
	}

	console.log(cliHelp)
}

const cli = !module.parent

if (cli) {
	const cliOpts = meow(cliHelp, cliDefs)
	run(cliOpts).catch(error => {
		fail(error.message)
	})
} else {
	module.exports = {run}
}
