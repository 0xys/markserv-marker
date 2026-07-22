'use strict'

const crypto = require('node:crypto')
const {EventEmitter} = require('node:events')
const fs = require('node:fs')
const path = require('node:path')

// In-memory store of everything the daemon serves. Lives for the process
// lifetime only — no persistence, by design.
const events = new EventEmitter()
const registrations = new Map()

const idForPath = realPath =>
	crypto.createHash('sha1').update(realPath).digest('hex').slice(0, 10)

// Register a file or directory. Throws (ENOENT etc.) if the path is missing.
// Idempotent: the id derives from the realpath, so re-registering the same
// path (even through a symlink) returns the existing registration.
const register = absPath => {
	const realPath = fs.realpathSync(absPath)
	const stat = fs.statSync(realPath)
	const type = stat.isDirectory() ? 'dir' : 'file'
	const id = idForPath(realPath)

	if (registrations.has(id)) {
		return {reg: registrations.get(id), created: false}
	}

	const root = type === 'dir' ? realPath : path.dirname(realPath)
	const name = path.basename(realPath)
	const urlPath = type === 'dir' ?
		`/f/${id}/` :
		`/f/${id}/${encodeURIComponent(name)}`

	const reg = {
		id,
		path: realPath,
		type,
		root,
		name,
		urlPath,
		registeredAt: new Date().toISOString(),
		comments: new Map(),
		nextCommentSeq: 1
	}

	registrations.set(id, reg)
	events.emit('register', reg)
	return {reg, created: true}
}

const get = id => registrations.get(id)

const list = () => [...registrations.values()]

const unregister = id => {
	const reg = registrations.get(id)
	if (!reg) {
		return false
	}

	registrations.delete(id)
	events.emit('unregister', reg)
	return true
}

// Comment ids are globally unique ('<fileId>-c<seq>') so that
// /api/comments/:id can address them without a file id.
const commentFileId = commentId => commentId.split('-')[0]

const findComment = commentId => {
	const reg = registrations.get(commentFileId(commentId))
	if (!reg) {
		return null
	}

	return reg.comments.get(commentId) || null
}

// Collapse whitespace runs to single spaces, keeping a map from each
// normalized index back to the raw index it came from
const normalizeWithMap = raw => {
	let text = ''
	const map = []
	let inWs = false
	// Split('') keeps UTF-16 indices aligned with the raw string (spread
	// would split by code point and misalign map[] for surrogate pairs)
	// eslint-disable-next-line unicorn/prefer-spread
	for (const [i, element] of raw.split('').entries()) {
		if (/\s/.test(element)) {
			if (!inWs && text.length > 0) {
				text += ' '
				map.push(i)
			}

			inWs = true
		} else {
			text += element
			map.push(i)
			inWs = false
		}
	}

	return {text, map}
}

// The UI can only report the enclosing block's line range (a code fence or
// list can span many lines). When the comment carries the selected text,
// narrow the range down to the lines the selection actually touches.
const narrowRange = (lines, lineStart, lineEnd, quote) => {
	const blockLines = lines.slice(lineStart - 1, lineEnd)

	let raw = ''
	const lineOf = []
	for (const [k, line] of blockLines.entries()) {
		for (let i = 0; i <= line.length; i++) {
			lineOf.push(lineStart + k)
		}

		raw += line + '\n'
	}

	const {text, map} = normalizeWithMap(raw)
	const needle = normalizeWithMap(quote).text.trim()
	if (!needle) {
		return {lineStart, lineEnd}
	}

	const index = text.indexOf(needle)
	if (index !== -1) {
		return {
			lineStart: lineOf[map[index]],
			lineEnd: lineOf[map[index + needle.length - 1]]
		}
	}

	// Markdown syntax (e.g. **bold**) can interrupt the rendered quote in
	// the source: fall back to locating its first and last words
	const words = needle.split(' ').filter(word => word.length > 1)
	if (words.length > 0) {
		let start = null
		let end = null
		for (const [k, line] of blockLines.entries()) {
			if (start === null && line.includes(words[0])) {
				start = lineStart + k
			}

			if (start !== null && end === null && line.includes(words.at(-1)) &&
				lineStart + k >= start) {
				end = lineStart + k
			}
		}

		if (start !== null && end !== null) {
			return {lineStart: start, lineEnd: end}
		}
	}

	return {lineStart, lineEnd}
}

const addComment = (fileId, {lineStart, lineEnd, quote, parentId, author, body}) => {
	const reg = registrations.get(fileId)
	if (!reg) {
		return null
	}

	let root = null
	if (parentId) {
		const parent = reg.comments.get(parentId)
		if (!parent) {
			const error = new Error(`Parent comment not found: ${parentId}`)
			error.code = 'parent-not-found'
			throw error
		}

		// Threads are one level deep: replying to a reply attaches to its root
		root = parent.parentId ? reg.comments.get(parent.parentId) : parent
	}

	// For root comments: narrow the block-level range to the selected
	// lines (via the quote) and snapshot exactly those lines
	let effectiveStart = lineStart
	let effectiveEnd = lineEnd
	let snapshot = null
	if (!root && Number.isInteger(lineStart) && reg.type === 'file') {
		let lines = null
		try {
			lines = fs.readFileSync(reg.path, 'utf8').split('\n')
		} catch {}

		if (lines) {
			if (quote) {
				({lineStart: effectiveStart, lineEnd: effectiveEnd} =
					narrowRange(lines, lineStart, lineEnd, quote))
			}

			snapshot = {
				lineStart: effectiveStart,
				lineEnd: effectiveEnd,
				text: lines.slice(effectiveStart - 1, effectiveEnd).join('\n')
			}
		}
	}

	const id = `${fileId}-c${reg.nextCommentSeq++}`
	const comment = {
		id,
		fileId,
		lineStart: root ? root.lineStart : effectiveStart,
		lineEnd: root ? root.lineEnd : effectiveEnd,
		quote: root ? null : (quote || null),
		snapshot: root ? null : snapshot,
		parentId: root ? root.id : null,
		author,
		body,
		createdAt: new Date().toISOString(),
		resolved: false
	}

	reg.comments.set(id, comment)
	return comment
}

const updateComment = (commentId, patch) => {
	const comment = findComment(commentId)
	if (!comment) {
		return null
	}

	if (typeof patch.resolved === 'boolean') {
		if (comment.parentId) {
			const error = new Error('Only thread root comments can be resolved')
			error.code = 'resolve-reply'
			throw error
		}

		comment.resolved = patch.resolved
	}

	if (typeof patch.body === 'string') {
		comment.body = patch.body
	}

	return comment
}

const deleteComment = commentId => {
	const reg = registrations.get(commentFileId(commentId))
	if (!reg || !reg.comments.has(commentId)) {
		return false
	}

	const comment = reg.comments.get(commentId)
	reg.comments.delete(commentId)

	if (!comment.parentId) {
		for (const [id, other] of reg.comments) {
			if (other.parentId === comment.id) {
				reg.comments.delete(id)
			}
		}
	}

	return true
}

// Returns threads: root comments (sorted by line, then time) each with a
// `replies` array (sorted by time). Options:
//   resolved: true/false — only threads whose root matches
//   since: ISO string — only threads with any comment newer than this
const getThreads = (fileId, options = {}) => {
	const reg = registrations.get(fileId)
	if (!reg) {
		return null
	}

	const all = [...reg.comments.values()]
	const roots = all.filter(comment => !comment.parentId)

	roots.sort((a, b) =>
		(a.lineStart - b.lineStart) ||
		(a.createdAt < b.createdAt ? -1 : 1))

	// Read the file once to tell each snapshot whether its lines changed
	let currentLines = null
	if (reg.type === 'file') {
		try {
			currentLines = fs.readFileSync(reg.path, 'utf8').split('\n')
		} catch {}
	}

	let threads = roots.map(root => {
		const replies = all
			.filter(comment => comment.parentId === root.id)
			.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
			.map(comment => ({...comment}))

		let currentText = null
		let changed = false
		if (root.snapshot && currentLines) {
			currentText = currentLines
				.slice(root.snapshot.lineStart - 1, root.snapshot.lineEnd)
				.join('\n')
			changed = currentText !== root.snapshot.text

			// Edits above the comment shift its lines without touching them:
			// if the snapshot still exists verbatim somewhere, it only moved
			if (changed) {
				const paddedFile = '\n' + currentLines.join('\n') + '\n'
				if (paddedFile.includes('\n' + root.snapshot.text + '\n')) {
					changed = false
				}
			}
		}

		return {
			...root, replies, currentText, changed
		}
	})

	if (typeof options.resolved === 'boolean') {
		threads = threads.filter(thread => thread.resolved === options.resolved)
	}

	if (options.since) {
		threads = threads.filter(thread =>
			thread.createdAt > options.since ||
			thread.replies.some(reply => reply.createdAt > options.since))
	}

	return threads
}

const commentCounts = fileId => {
	const reg = registrations.get(fileId)
	if (!reg) {
		return {total: 0, unresolved: 0}
	}

	let total = 0
	let unresolved = 0
	for (const comment of reg.comments.values()) {
		total++
		if (!comment.parentId && !comment.resolved) {
			unresolved++
		}
	}

	return {total, unresolved}
}

// Test helper: wipe all state (emits unregister so watchers get cleaned up)
const reset = () => {
	for (const id of registrations.keys()) {
		unregister(id)
	}
}

module.exports = {
	events,
	register,
	get,
	list,
	unregister,
	addComment,
	updateComment,
	deleteComment,
	findComment,
	getThreads,
	commentCounts,
	reset
}
