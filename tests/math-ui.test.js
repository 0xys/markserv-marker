'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('ava')
const {JSDOM} = require('jsdom')

const MATH_JS = fs.readFileSync(
	path.join(__dirname, '..', 'lib', 'templates', 'math.js'), 'utf8')

const tick = ms => new Promise(resolve => {
	setTimeout(resolve, ms)
})

const buildPage = () => {
	const dom = new JSDOM(
		'<!DOCTYPE html><html><body><article class="markdown-body">' +
		'<div id="marker-content"><p>\\(x^2\\)</p></div></article></body></html>',
		{url: 'http://localhost:7642/f/abc123/test.md', runScripts: 'outside-only'})
	dom.window.eval(MATH_JS)
	return dom.window
}

// A stand-in for the MathJax 3 API the script uses
const stubMathJax = (window, startup = Promise.resolve()) => {
	const calls = []
	window.MathJax = {
		startup: {promise: startup},
		typesetClear() {
			calls.push(['clear'])
		},
		typesetPromise(elements) {
			calls.push(['typeset', elements])
			return Promise.resolve()
		}
	}
	return calls
}

const reload = window => {
	window.document.dispatchEvent(new window.CustomEvent('marker:reload'))
}

test('a hot reload typesets the new content again', async t => {
	const window = buildPage()
	const calls = stubMathJax(window)
	reload(window)
	await tick(0)

	t.is(calls.length, 2)
	t.deepEqual(calls[0], ['clear'])
	t.is(calls[1][0], 'typeset')
	t.is(calls[1][1].length, 1)
	t.is(calls[1][1][0], window.document.querySelector('#marker-content'))
})

test('a reload before MathJax has loaded does nothing and throws nothing', async t => {
	const window = buildPage()
	const errors = []
	window.addEventListener('error', event => errors.push(event))
	reload(window)
	// The config object MathJax reads before it loads has no API yet
	window.MathJax = {tex: {}}
	reload(window)
	await tick(0)
	t.is(errors.length, 0)
})

test('a reload during startup waits for the startup typeset', async t => {
	const window = buildPage()
	let finishStartup
	const calls = stubMathJax(window, new Promise(resolve => {
		finishStartup = resolve
	}))
	reload(window)
	await tick(0)
	t.is(calls.length, 0)

	finishStartup()
	await tick(0)
	t.is(calls.length, 2)
})
