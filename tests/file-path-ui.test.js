'use strict'

// The path strip above the page frame, shared by document pages and folder
// listings. What it shows comes from data-path; where its folder link goes
// comes from the URL, which is what makes one script right for both.

const fs = require('node:fs')
const path = require('node:path')
const test = require('ava')
const {JSDOM} = require('jsdom')

const FILE_PATH_JS = fs.readFileSync(
	path.join(__dirname, '..', 'lib', 'templates', 'file-path.js'), 'utf8')

const buildPage = ({url, dataPath, folder = false}) => {
	const dom = new JSDOM(
		`<!DOCTYPE html><html><body class="marker-doc">
			<article class="markdown-body">
				<div class="marker-file-path" id="marker-file-path"
					data-path="${dataPath}"${folder ? ' data-folder' : ''}></div>
			</article>
		</body></html>`,
		{url, runScripts: 'outside-only'})

	const {window} = dom
	const copied = []
	window.navigator.clipboard = {
		writeText(text) {
			copied.push(text)
			return Promise.resolve()
		}
	}

	window.eval(FILE_PATH_JS)
	const strip = window.document.querySelector('#marker-file-path')
	return {
		window,
		document: window.document,
		strip,
		copied,
		parts: strip ? [...strip.childNodes].map(node => `${node.className}:${node.textContent}`) : null,
		link: strip ? strip.querySelector('.marker-file-path-up') : null
	}
}

test('a document page names the file and links the folder it sits in', t => {
	const page = buildPage({url: 'http://localhost:7642/f/abc123/doc.md', dataPath: '/a/b/notes/doc.md'})

	t.deepEqual(page.parts, [
		'marker-file-path-dir:/a/b/',
		'marker-file-path-up:notes',
		'marker-file-path-sep:/',
		'marker-file-path-base:doc.md'
	])
	t.is(page.link.getAttribute('href'), '/f/abc123/')
	t.is(page.link.title, 'Open this folder')
})

test('a folder page names the folder and links the one above it', t => {
	const page = buildPage({url: 'http://localhost:7642/f/abc123/sub/', dataPath: '/a/b/notes/sub', folder: true})

	t.deepEqual(page.parts, [
		'marker-file-path-dir:/a/b/',
		'marker-file-path-up:notes',
		'marker-file-path-sep:/',
		'marker-file-path-base:sub',
		// The trailing slash says the bold name is a folder
		'marker-file-path-sep:/'
	])
	t.is(page.link.getAttribute('href'), '/f/abc123/')
})

test('the served root offers no way up, since there is none', t => {
	const page = buildPage({url: 'http://localhost:7642/f/abc123/', dataPath: '/a/b/notes', folder: true})

	t.falsy(page.link)
	t.deepEqual(page.parts, [
		'marker-file-path-dir:/a/b/',
		'marker-file-path-base:notes',
		'marker-file-path-sep:/'
	])
})

test('a file reached through a subdirectory links that subdirectory', t => {
	const page = buildPage({url: 'http://localhost:7642/f/abc123/sub/deep/doc.md', dataPath: '/a/b/notes/sub/deep/doc.md'})

	t.is(page.link.textContent, 'deep')
	t.is(page.link.getAttribute('href'), '/f/abc123/sub/deep/')
})

test('a long path elides its middle but keeps the folder and the name whole', t => {
	const long = '/Users/someone/code/a-fairly-deep/set/of/directories/leading/to/the-notes/doc.md'
	const page = buildPage({url: 'http://localhost:7642/f/abc123/doc.md', dataPath: long})

	t.is(page.link.textContent, 'the-notes')
	t.is(page.strip.querySelector('.marker-file-path-base').textContent, 'doc.md')
	t.regex(page.strip.textContent, /…/)
	// The data-path attribute keeps the whole thing, which is what the tooltip shows
	t.is(page.strip.dataset.path, long)
})

test('clicking the strip copies the path; clicking the folder link does not', t => {
	const page = buildPage({url: 'http://localhost:7642/f/abc123/doc.md', dataPath: '/a/b/notes/doc.md'})

	page.strip.querySelector('.marker-file-path-base')
		.dispatchEvent(new page.window.MouseEvent('click', {bubbles: true}))
	t.deepEqual(page.copied, ['/a/b/notes/doc.md'])

	page.link.dispatchEvent(new page.window.MouseEvent('click', {bubbles: true}))
	// Still the one copy: the link navigates instead
	t.deepEqual(page.copied, ['/a/b/notes/doc.md'])
})

test('a page with no path at all drops the strip', t => {
	const page = buildPage({url: 'http://localhost:7642/f/abc123/doc.md', dataPath: ''})
	t.falsy(page.document.querySelector('#marker-file-path'))
})
