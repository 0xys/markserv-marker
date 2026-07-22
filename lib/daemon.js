#!/usr/bin/env node

'use strict'

const path = require('node:path')
const fs = require('node:fs')
const meow = require('meow')

const server = require('./server')
const cliDefs = require('./cli-defs')

const cliHelp = String(fs.readFileSync(path.join(__dirname, 'cli-help.txt')))

const run = flags => {
	const daemonFlags = {
		...flags,
		$exitOnAddrInUse: true
	}

	return server.init(daemonFlags).catch(error => {
		console.error(error.message)
		process.exit(1)
	})
}

const cli = !module.parent

if (cli) {
	const cliOpts = meow(cliHelp, cliDefs)
	run(cliOpts.flags)
} else {
	module.exports = {run}
}
