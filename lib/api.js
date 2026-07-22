'use strict'

const fs = require('node:fs')
const path = require('node:path')

const registry = require('./registry')

const MAX_BODY_BYTES = 1024 * 1024

const readJsonBody = req => new Promise((resolve, reject) => {
	const chunks = []
	let size = 0

	req.on('data', chunk => {
		size += chunk.length
		if (size > MAX_BODY_BYTES) {
			const error = new Error('Request body too large (max 1 MB)')
			error.status = 413
			error.code = 'body-too-large'
			reject(error)
			req.destroy()
			return
		}

		chunks.push(chunk)
	})

	req.on('end', () => {
		if (chunks.length === 0) {
			return resolve({})
		}

		try {
			resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
		} catch {
			const error = new Error('Request body is not valid JSON')
			error.status = 400
			error.code = 'invalid-json'
			reject(error)
		}
	})

	req.on('error', reject)
})

const sendJson = (res, status, data) => {
	res.writeHead(status, {'content-type': 'application/json; charset=utf-8'})
	res.end(JSON.stringify(data))
}

const sendError = (res, status, code, message) =>
	sendJson(res, status, {error: {code, message}})

const badRequest = (code, message) => {
	const error = new Error(message)
	error.status = 400
	error.code = code
	return error
}

const parseLineFields = body => {
	const lineStart = body.lineStart === undefined ? body.line : body.lineStart
	const lineEnd = body.lineEnd === undefined ? lineStart : body.lineEnd

	if (!Number.isInteger(lineStart) || lineStart < 1 ||
		!Number.isInteger(lineEnd) || lineEnd < lineStart) {
		throw badRequest('invalid-line',
			'Provide "line" or "lineStart"/"lineEnd" as 1-based integers (lineEnd >= lineStart)')
	}

	return {lineStart, lineEnd}
}

// Creates the connect middleware serving everything under /api.
// deps: {flags, pkg, startedAt, notify: {commentChange(fileId)}, onShutdown()}
const createApiHandler = deps => {
	const {flags, pkg, startedAt, notify} = deps

	const serveOrigin = () => `http://${flags.address}:${flags.$httpPort}`

	const fileSummary = reg => ({
		id: reg.id,
		path: reg.path,
		name: reg.name,
		type: reg.type,
		url: serveOrigin() + reg.urlPath,
		registeredAt: reg.registeredAt,
		comments: registry.commentCounts(reg.id)
	})

	const health = (req, res) => {
		sendJson(res, 200, {
			name: pkg.name,
			version: pkg.version,
			pid: process.pid,
			startedAt,
			port: flags.$httpPort,
			files: registry.list().length
		})
	}

	const listFiles = (req, res) => {
		sendJson(res, 200, {files: registry.list().map(reg => fileSummary(reg))})
	}

	const createFile = async (req, res) => {
		const body = await readJsonBody(req)
		if (typeof body.path !== 'string' || body.path.length === 0) {
			throw badRequest('missing-path', 'Provide "path" (absolute, or relative to the daemon cwd)')
		}

		const absPath = path.resolve(process.cwd(), body.path)

		let result
		try {
			result = registry.register(absPath)
		} catch {
			return sendError(res, 404, 'file-not-found', `No such file or directory: ${absPath}`)
		}

		const {reg, created} = result
		sendJson(res, created ? 201 : 200, {...fileSummary(reg), created})
	}

	const getFileInfo = (req, res, [id]) => {
		const reg = registry.get(id)
		if (!reg) {
			return sendError(res, 404, 'not-registered', `No registration with id: ${id}`)
		}

		sendJson(res, 200, fileSummary(reg))
	}

	const removeFile = (req, res, [id]) => {
		if (!registry.unregister(id)) {
			return sendError(res, 404, 'not-registered', `No registration with id: ${id}`)
		}

		res.writeHead(204)
		res.end()
	}

	const getContent = (req, res, [id]) => {
		const reg = registry.get(id)
		if (!reg) {
			return sendError(res, 404, 'not-registered', `No registration with id: ${id}`)
		}

		if (reg.type !== 'file') {
			return sendError(res, 400, 'not-a-file', 'Content is only available for file registrations')
		}

		let content
		try {
			content = fs.readFileSync(reg.path, 'utf8')
		} catch {
			return sendError(res, 404, 'file-not-found', `File no longer exists: ${reg.path}`)
		}

		sendJson(res, 200, {
			id: reg.id,
			path: reg.path,
			lines: content.split('\n').length,
			content
		})
	}

	const listComments = (req, res, [id], searchParams) => {
		const reg = registry.get(id)
		if (!reg) {
			return sendError(res, 404, 'not-registered', `No registration with id: ${id}`)
		}

		const options = {}
		const resolved = searchParams.get('resolved')
		if (resolved === 'true' || resolved === 'false') {
			options.resolved = resolved === 'true'
		}

		const since = searchParams.get('since')
		if (since) {
			if (Number.isNaN(Date.parse(since))) {
				return sendError(res, 400, 'invalid-since', '"since" must be an ISO 8601 timestamp')
			}

			options.since = new Date(since).toISOString()
		}

		sendJson(res, 200, {
			fileId: reg.id,
			path: reg.path,
			threads: registry.getThreads(reg.id, options)
		})
	}

	const createComment = async (req, res, [id]) => {
		const reg = registry.get(id)
		if (!reg) {
			return sendError(res, 404, 'not-registered', `No registration with id: ${id}`)
		}

		const body = await readJsonBody(req)

		if (typeof body.body !== 'string' || body.body.trim().length === 0) {
			throw badRequest('missing-body', 'Provide a non-empty "body"')
		}

		if (typeof body.author !== 'string' || body.author.trim().length === 0) {
			throw badRequest('missing-author', 'Provide a non-empty "author"')
		}

		if (body.quote !== undefined && body.quote !== null &&
			(typeof body.quote !== 'string' || body.quote.length > 2000)) {
			throw badRequest('invalid-quote', '"quote" must be a string of at most 2000 characters')
		}

		const fields = {
			parentId: body.parentId,
			author: body.author.trim(),
			body: body.body,
			quote: body.quote
		}

		if (body.parentId === undefined || body.parentId === null) {
			Object.assign(fields, parseLineFields(body))
		} else if (typeof body.parentId !== 'string') {
			throw badRequest('invalid-parent', '"parentId" must be a comment id string')
		}

		let comment
		try {
			comment = registry.addComment(reg.id, fields)
		} catch (error) {
			if (error.code === 'parent-not-found') {
				throw badRequest('parent-not-found', error.message)
			}

			throw error
		}

		notify.commentChange(reg.id)
		sendJson(res, 201, comment)
	}

	const patchComment = async (req, res, [commentId]) => {
		const body = await readJsonBody(req)

		if (body.resolved !== undefined && typeof body.resolved !== 'boolean') {
			throw badRequest('invalid-resolved', '"resolved" must be a boolean')
		}

		if (body.body !== undefined &&
			(typeof body.body !== 'string' || body.body.trim().length === 0)) {
			throw badRequest('invalid-body', '"body" must be a non-empty string')
		}

		let comment
		try {
			comment = registry.updateComment(commentId, {resolved: body.resolved, body: body.body})
		} catch (error) {
			if (error.code === 'resolve-reply') {
				throw badRequest('resolve-reply', error.message)
			}

			throw error
		}

		if (!comment) {
			return sendError(res, 404, 'comment-not-found', `No comment with id: ${commentId}`)
		}

		notify.commentChange(comment.fileId)
		sendJson(res, 200, comment)
	}

	const removeComment = (req, res, [commentId]) => {
		const comment = registry.findComment(commentId)
		if (!comment || !registry.deleteComment(commentId)) {
			return sendError(res, 404, 'comment-not-found', `No comment with id: ${commentId}`)
		}

		notify.commentChange(comment.fileId)
		res.writeHead(204)
		res.end()
	}

	const shutdown = (req, res) => {
		sendJson(res, 200, {ok: true})
		setImmediate(() => deps.onShutdown())
	}

	const routes = [
		['GET', /^\/health$/, health],
		['GET', /^\/files$/, listFiles],
		['POST', /^\/files$/, createFile],
		['GET', /^\/files\/([^/]+)$/, getFileInfo],
		['DELETE', /^\/files\/([^/]+)$/, removeFile],
		['GET', /^\/files\/([^/]+)\/content$/, getContent],
		['GET', /^\/files\/([^/]+)\/comments$/, listComments],
		['POST', /^\/files\/([^/]+)\/comments$/, createComment],
		['PATCH', /^\/comments\/([^/]+)$/, patchComment],
		['DELETE', /^\/comments\/([^/]+)$/, removeComment],
		['POST', /^\/shutdown$/, shutdown]
	]

	return (req, res) => {
		const url = new URL(req.url, 'http://localhost')

		for (const [method, pattern, handler] of routes) {
			if (req.method !== method) {
				continue
			}

			const match = url.pathname.match(pattern)
			if (!match) {
				continue
			}

			Promise.resolve(handler(req, res, match.slice(1), url.searchParams))
				.catch(error => {
					if (error.status) {
						return sendError(res, error.status, error.code || 'error', error.message)
					}

					console.error(error)
					sendError(res, 500, 'internal', error.message)
				})
			return
		}

		sendError(res, 404, 'no-such-endpoint', `No API endpoint: ${req.method} ${url.pathname}`)
	}
}

module.exports = createApiHandler
