'use strict'

const path = require('node:path')

// What the daemon does with a file is decided by its extension alone. Shared
// by the server, which picks a renderer from it, and the API, which writes
// only to the kinds of file that have a page to edit them from.
const fileTypes = {
	markdown: [
		'.markdown',
		'.mdown',
		'.mkdn',
		'.md',
		'.mkd',
		'.mdwn',
		'.mdtxt',
		'.mdtext',
		'.text'
	],

	html: [
		'.html',
		'.htm'
	],

	// Rendered as a diff block: a page of their own, and the browser can
	// compare the two sides. Served raw they only prompt a download.
	diff: [
		'.diff',
		'.patch'
	],

	watch: [
		'.sass',
		'.less',
		'.js',
		'.css',
		'.json',
		'.gif',
		'.png',
		'.jpg',
		'.jpeg'
	],

	exclusions: [
		'node_modules/',
		'.git/'
	]
}

fileTypes.watch = [...fileTypes.watch, ...fileTypes.markdown, ...fileTypes.html, ...fileTypes.diff]

const isType = (exts, filePath) => exts.includes(path.parse(filePath).ext)

// The editor lives on the document page, which only markdown and diff files
// get, so those are the only files PATCH /content will write to. Anything
// else registered — a script, a config file — is served as it is and has no
// business being rewritten through the API.
const isEditable = filePath =>
	isType(fileTypes.markdown, filePath) || isType(fileTypes.diff, filePath)

module.exports = {fileTypes, isType, isEditable}
