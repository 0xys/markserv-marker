'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('ava')
const getPort = require('get-port')

const server = require('../lib/server')
const registry = require('../lib/registry')

let service
let base
let fileId
let fixtureDir

test.before(async () => {
	fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-comments-'))
	fs.writeFileSync(path.join(fixtureDir, 'review.md'),
		'# Doc\n\nline three\n\nline five\n')

	const port = await getPort()
	service = await server.init({
		port,
		address: 'localhost',
		silent: true,
		hotreload: false,
		theme: 'dark'
	})
	base = `http://localhost:${port}`

	const {reg} = registry.register(path.join(fixtureDir, 'review.md'))
	fileId = reg.id
})

test.after.always(() => {
	registry.reset()
	if (service) {
		service.close()
	}
})

const api = async (method, urlPath, body) => {
	const response = await fetch(`${base}/api${urlPath}`, {
		method,
		headers: body ? {'content-type': 'application/json'} : undefined,
		body: body ? JSON.stringify(body) : undefined
	})

	let data = null
	if (response.status !== 204) {
		data = await response.json()
	}

	return {status: response.status, data}
}

test.serial('posting a root comment and a reply builds a thread', async t => {
	const root = await api('POST', `/files/${fileId}/comments`, {
		line: 3, body: 'This line is unclear', author: 'reviewer'
	})
	t.is(root.status, 201)
	t.is(root.data.lineStart, 3)
	t.is(root.data.lineEnd, 3)
	t.is(root.data.parentId, null)
	t.false(root.data.resolved)
	t.regex(root.data.id, new RegExp(`^${fileId}-c\\d+$`))

	const reply = await api('POST', `/files/${fileId}/comments`, {
		parentId: root.data.id, body: 'Agreed, will fix', author: 'claude'
	})
	t.is(reply.status, 201)
	t.is(reply.data.parentId, root.data.id)
	t.is(reply.data.lineStart, 3)

	const list = await api('GET', `/files/${fileId}/comments`)
	t.is(list.status, 200)
	t.is(list.data.fileId, fileId)
	t.is(list.data.threads.length, 1)
	t.is(list.data.threads[0].id, root.data.id)
	t.is(list.data.threads[0].replies.length, 1)
	t.is(list.data.threads[0].replies[0].author, 'claude')
})

test.serial('replying to a reply attaches to the thread root', async t => {
	const list = await api('GET', `/files/${fileId}/comments`)
	const replyId = list.data.threads[0].replies[0].id

	const nested = await api('POST', `/files/${fileId}/comments`, {
		parentId: replyId, body: 'One level only', author: 'reviewer'
	})
	t.is(nested.status, 201)
	t.is(nested.data.parentId, list.data.threads[0].id)
})

test.serial('line ranges are supported', async t => {
	const ranged = await api('POST', `/files/${fileId}/comments`, {
		lineStart: 3, lineEnd: 5, body: 'This whole block', author: 'reviewer'
	})
	t.is(ranged.status, 201)
	t.is(ranged.data.lineStart, 3)
	t.is(ranged.data.lineEnd, 5)
})

test.serial('snapshots record the commented lines and flag later edits', async t => {
	const filePath = path.join(fixtureDir, 'review.md')
	const original = fs.readFileSync(filePath, 'utf8')

	const posted = await api('POST', `/files/${fileId}/comments`, {
		line: 3, body: 'Watch this line', author: 'reviewer'
	})
	t.is(posted.status, 201)
	t.deepEqual(posted.data.snapshot, {lineStart: 3, lineEnd: 3, text: 'line three'})

	// Unchanged file: thread reports changed=false and the same text
	let list = await api('GET', `/files/${fileId}/comments`)
	let thread = list.data.threads.find(th => th.id === posted.data.id)
	t.false(thread.changed)
	t.is(thread.currentText, 'line three')

	// Edit the commented line: changed flips, snapshot keeps the original
	fs.writeFileSync(filePath, original.replace('line three', 'line three EDITED'))
	list = await api('GET', `/files/${fileId}/comments`)
	thread = list.data.threads.find(th => th.id === posted.data.id)
	t.true(thread.changed)
	t.is(thread.snapshot.text, 'line three')
	t.is(thread.currentText, 'line three EDITED')

	// Replies carry no snapshot
	const reply = await api('POST', `/files/${fileId}/comments`, {
		parentId: posted.data.id, body: 'ack', author: 'claude'
	})
	t.is(reply.data.snapshot, null)

	// Restore the fixture and clean up so later tests are unaffected
	fs.writeFileSync(filePath, original)
	await api('DELETE', `/comments/${posted.data.id}`)
})

test.serial('a quote narrows a block-level range to the selected lines', async t => {
	// A code fence spans many source lines but the UI can only report the
	// whole block; the quote should pin the comment to the real line
	const fencePath = path.join(fixtureDir, 'fence.md')
	fs.writeFileSync(fencePath, [
		'# Usage', //          Line 1
		'', //                 Line 2
		'```console', //       Line 3
		'$ tool start', //     Line 4
		'$ tool status', //    Line 5
		'$ tool stop   # stop the daemon', // Line 6
		'```', //              Line 7
		''
	].join('\n'))
	const {reg} = registry.register(fencePath)

	const posted = await api('POST', `/files/${reg.id}/comments`, {
		lineStart: 3, lineEnd: 7, quote: 'stop the daemon', body: 'About this line', author: 'reviewer'
	})
	t.is(posted.status, 201)
	t.is(posted.data.lineStart, 6)
	t.is(posted.data.lineEnd, 6)
	t.deepEqual(posted.data.snapshot,
		{lineStart: 6, lineEnd: 6, text: '$ tool stop   # stop the daemon'})

	// A quote interrupted by markdown syntax narrows via word fallback
	const proseePath = path.join(fixtureDir, 'prose.md')
	fs.writeFileSync(proseePath, '# T\n\nfiller\n\nwith **bold words** here\n')
	const {reg: prose} = registry.register(proseePath)
	const fallback = await api('POST', `/files/${prose.id}/comments`, {
		lineStart: 3, lineEnd: 5, quote: 'with bold words here', body: 'x', author: 'y'
	})
	t.is(fallback.data.lineStart, 5)
	t.is(fallback.data.lineEnd, 5)

	registry.unregister(reg.id)
	registry.unregister(prose.id)
})

test.serial('edits above the comment do not flag it as changed', async t => {
	const shiftPath = path.join(fixtureDir, 'shift.md')
	const original = '# T\n\nfirst\n\ntarget line\n'
	fs.writeFileSync(shiftPath, original)
	const {reg} = registry.register(shiftPath)

	const posted = await api('POST', `/files/${reg.id}/comments`, {
		line: 5, body: 'watch target', author: 'reviewer'
	})
	t.is(posted.data.snapshot.text, 'target line')

	// Insert a line above: the target only shifts, so changed stays false
	fs.writeFileSync(shiftPath, '# T\n\nNEW LINE\n\nfirst\n\ntarget line\n')
	let list = await api('GET', `/files/${reg.id}/comments`)
	t.false(list.data.threads[0].changed)

	// Actually edit the target: now changed flips
	fs.writeFileSync(shiftPath, '# T\n\nNEW LINE\n\nfirst\n\ntarget line EDITED\n')
	list = await api('GET', `/files/${reg.id}/comments`)
	t.true(list.data.threads[0].changed)

	registry.unregister(reg.id)
})

test.serial('quoteIndex narrows to the selected occurrence inside the block', async t => {
	// One sentence per line, so all three lines are a single paragraph block
	// and the UI can only report 3-5. "TODO" appears on lines 3 and 5.
	const dupePath = path.join(fixtureDir, 'dupes.md')
	fs.writeFileSync(dupePath,
		['# Doc', '', 'まず TODO を確認する。', '次に別の作業をする。', '最後に TODO を消す。', ''].join('\n'))
	const {reg} = registry.register(dupePath)

	const post = (quoteIndex, body) => api('POST', `/files/${reg.id}/comments`, {
		lineStart: 3, lineEnd: 5, quote: 'TODO', quoteIndex, body, author: 'reviewer'
	})

	const first = await post(0, 'the one on line 3')
	t.is(first.data.lineStart, 3)
	t.is(first.data.quoteIndex, 0)
	t.is(first.data.snapshot.text, 'まず TODO を確認する。')

	const second = await post(1, 'the one on line 5')
	t.is(second.data.lineStart, 5)
	t.is(second.data.lineEnd, 5)
	t.is(second.data.quoteIndex, 1)
	t.is(second.data.snapshot.text, '最後に TODO を消す。')

	// Omitting it keeps the old behaviour: the first occurrence
	const legacy = await api('POST', `/files/${reg.id}/comments`, {
		lineStart: 3, lineEnd: 5, quote: 'TODO', body: 'no index', author: 'reviewer'
	})
	t.is(legacy.data.lineStart, 3)
	t.is(legacy.data.quoteIndex, 0)

	// More than the source has: clamped to the last one rather than rejected
	const beyond = await post(9, 'out of range')
	t.is(beyond.data.lineStart, 5)

	// Replies carry no quote, so no index either
	const reply = await api('POST', `/files/${reg.id}/comments`, {
		parentId: second.data.id, body: 'ack', author: 'claude'
	})
	t.is(reply.data.quoteIndex, 0)

	const bad = await api('POST', `/files/${reg.id}/comments`, {
		lineStart: 3, lineEnd: 5, quote: 'TODO', quoteIndex: -1, body: 'x', author: 'y'
	})
	t.is(bad.status, 400)
	t.is(bad.data.error.code, 'invalid-quote-index')

	registry.unregister(reg.id)
})

test.serial('shifted comments report the lines the text sits on now', async t => {
	const movePath = path.join(fixtureDir, 'move.md')
	fs.writeFileSync(movePath, '# T\n\nfirst\n\ntarget line\n')
	const {reg} = registry.register(movePath)

	const posted = await api('POST', `/files/${reg.id}/comments`, {
		line: 5, body: 'watch target', author: 'reviewer'
	})
	t.is(posted.data.lineStart, 5)

	const reply = await api('POST', `/files/${reg.id}/comments`, {
		parentId: posted.data.id, body: 'ack', author: 'claude'
	})
	t.is(reply.status, 201)

	const firstThread = async () => {
		const list = await api('GET', `/files/${reg.id}/comments`)
		return list.data.threads[0]
	}

	// Two lines inserted above: the comment follows its text down to line 7
	fs.writeFileSync(movePath, '# T\n\nfirst\n\nBRAND NEW\n\ntarget line\n')
	let thread = await firstThread()
	t.is(thread.lineStart, 7)
	t.is(thread.lineEnd, 7)
	t.false(thread.changed)
	t.is(thread.currentText, 'target line')
	// The snapshot still records where it was written
	t.is(thread.snapshot.lineStart, 5)
	// Replies follow the root
	t.is(thread.replies[0].lineStart, 7)

	// Lines removed above: it follows back up
	fs.writeFileSync(movePath, '# T\n\ntarget line\n')
	thread = await firstThread()
	t.is(thread.lineStart, 3)
	t.false(thread.changed)

	// The text itself edited: no re-anchor, and changed flips
	fs.writeFileSync(movePath, '# T\n\ntarget line EDITED\n')
	thread = await firstThread()
	t.is(thread.lineStart, 5)
	t.true(thread.changed)

	registry.unregister(reg.id)
})

test.serial('re-anchoring picks the copy nearest to where the comment was written', async t => {
	const twinPath = path.join(fixtureDir, 'twins.md')
	// The same line appears twice; the comment is about the second one
	fs.writeFileSync(twinPath,
		['# T', '', '- [ ] check', '', 'filler', '', '- [ ] check', ''].join('\n'))
	const {reg} = registry.register(twinPath)

	const posted = await api('POST', `/files/${reg.id}/comments`, {
		line: 7, body: 'the second one', author: 'reviewer'
	})
	t.is(posted.data.snapshot.text, '- [ ] check')
	t.is(posted.data.snapshot.lineStart, 7)

	// One line inserted above both copies: they move to 4 and 8. Measured from
	// the original line 7, the copy at 8 is nearer than the one at 4.
	fs.writeFileSync(twinPath,
		['# T', 'INSERTED', '', '- [ ] check', '', 'filler', '', '- [ ] check', ''].join('\n'))
	const list = await api('GET', `/files/${reg.id}/comments`)
	const [thread] = list.data.threads
	t.is(thread.lineStart, 8)
	t.false(thread.changed)

	registry.unregister(reg.id)
})

test.serial('a selection quote round-trips through the API', async t => {
	const quoted = await api('POST', `/files/${fileId}/comments`, {
		line: 3, quote: 'line three', body: 'About this phrase', author: 'reviewer'
	})
	t.is(quoted.status, 201)
	t.is(quoted.data.quote, 'line three')

	const list = await api('GET', `/files/${fileId}/comments`)
	const thread = list.data.threads.find(th => th.id === quoted.data.id)
	t.is(thread.quote, 'line three')

	const badQuote = await api('POST', `/files/${fileId}/comments`, {
		line: 3, quote: 42, body: 'x', author: 'x'
	})
	t.is(badQuote.status, 400)
	t.is(badQuote.data.error.code, 'invalid-quote')

	// Clean up so later count assertions stay stable
	await api('DELETE', `/comments/${quoted.data.id}`)
})

test.serial('resolving works on roots and 400s on replies', async t => {
	const list = await api('GET', `/files/${fileId}/comments`)
	const thread = list.data.threads[0]

	const resolved = await api('PATCH', `/comments/${thread.id}`, {resolved: true})
	t.is(resolved.status, 200)
	t.true(resolved.data.resolved)

	const replyResolve = await api('PATCH', `/comments/${thread.replies[0].id}`, {resolved: true})
	t.is(replyResolve.status, 400)
	t.is(replyResolve.data.error.code, 'resolve-reply')
})

test.serial('resolved filter returns only matching threads', async t => {
	const open = await api('GET', `/files/${fileId}/comments?resolved=false`)
	t.is(open.data.threads.length, 1)
	t.false(open.data.threads[0].resolved)

	const closed = await api('GET', `/files/${fileId}/comments?resolved=true`)
	t.is(closed.data.threads.length, 1)
	t.true(closed.data.threads[0].resolved)
})

test.serial('since filter returns threads with newer activity', async t => {
	const before = new Date(Date.now() + 60_000).toISOString()
	const none = await api('GET', `/files/${fileId}/comments?since=${encodeURIComponent(before)}`)
	t.is(none.data.threads.length, 0)

	const past = new Date(Date.now() - 60_000).toISOString()
	const all = await api('GET', `/files/${fileId}/comments?since=${encodeURIComponent(past)}`)
	t.is(all.data.threads.length, 2)

	const bad = await api('GET', `/files/${fileId}/comments?since=yesterday`)
	t.is(bad.status, 400)
})

test.serial('validation errors are reported as 400s', async t => {
	const noBody = await api('POST', `/files/${fileId}/comments`, {line: 1, author: 'x'})
	t.is(noBody.status, 400)
	t.is(noBody.data.error.code, 'missing-body')

	const noAuthor = await api('POST', `/files/${fileId}/comments`, {line: 1, body: 'x'})
	t.is(noAuthor.status, 400)
	t.is(noAuthor.data.error.code, 'missing-author')

	const noLine = await api('POST', `/files/${fileId}/comments`, {body: 'x', author: 'x'})
	t.is(noLine.status, 400)
	t.is(noLine.data.error.code, 'invalid-line')

	const badRange = await api('POST', `/files/${fileId}/comments`, {
		lineStart: 5, lineEnd: 3, body: 'x', author: 'x'
	})
	t.is(badRange.status, 400)

	const badParent = await api('POST', `/files/${fileId}/comments`, {
		parentId: `${fileId}-c999`, body: 'x', author: 'x'
	})
	t.is(badParent.status, 400)
	t.is(badParent.data.error.code, 'parent-not-found')
})

test.serial('comment counts appear in file listings', async t => {
	const list = await api('GET', '/files')
	const file = list.data.files.find(f => f.id === fileId)
	// Two roots (one resolved) + two replies
	t.is(file.comments.total, 4)
	t.is(file.comments.unresolved, 1)
})

test.serial('editing a comment body works', async t => {
	const list = await api('GET', `/files/${fileId}/comments`)
	const thread = list.data.threads[1]

	const edited = await api('PATCH', `/comments/${thread.id}`, {body: 'Edited body'})
	t.is(edited.status, 200)
	t.is(edited.data.body, 'Edited body')
})

test.serial('deleting a root deletes its replies', async t => {
	const list = await api('GET', `/files/${fileId}/comments`)
	const thread = list.data.threads.find(th => th.replies.length > 0)

	const removed = await api('DELETE', `/comments/${thread.id}`)
	t.is(removed.status, 204)

	const after = await api('GET', `/files/${fileId}/comments`)
	t.false(after.data.threads.some(th => th.id === thread.id))
	const ids = after.data.threads.flatMap(th => [th.id, ...th.replies.map(r => r.id)])
	t.false(ids.some(id => thread.replies.map(r => r.id).includes(id)))
})

test.serial('unknown comment ids yield 404', async t => {
	const patch = await api('PATCH', '/comments/ffffffffff-c1', {resolved: true})
	t.is(patch.status, 404)

	const removed = await api('DELETE', '/comments/ffffffffff-c1')
	t.is(removed.status, 404)
})

test.serial('content endpoint exposes raw markdown for line mapping', async t => {
	const content = await api('GET', `/files/${fileId}/content`)
	t.is(content.status, 200)
	t.true(content.data.content.includes('line three'))
	t.is(content.data.lines, 6)
})

test.serial('bulk delete clears comments, optionally only resolved threads', async t => {
	const bulkPath = path.join(fixtureDir, 'bulk.md')
	fs.writeFileSync(bulkPath, '# T\n\none\n\ntwo\n\nthree\n')
	const {reg} = registry.register(bulkPath)

	const openThread = await api('POST', `/files/${reg.id}/comments`, {
		line: 3, body: 'keep me', author: 'reviewer'
	})
	const doneThread = await api('POST', `/files/${reg.id}/comments`, {
		line: 5, body: 'done already', author: 'reviewer'
	})
	await api('POST', `/files/${reg.id}/comments`, {
		parentId: doneThread.data.id, body: 'fixed', author: 'claude'
	})
	await api('PATCH', `/comments/${doneThread.data.id}`, {resolved: true})

	// Clean only the resolved clutter: root + its reply go, open thread stays
	const cleaned = await api('DELETE', `/files/${reg.id}/comments?resolved=true`)
	t.is(cleaned.status, 200)
	t.is(cleaned.data.deleted, 2)

	let list = await api('GET', `/files/${reg.id}/comments`)
	t.is(list.data.threads.length, 1)
	t.is(list.data.threads[0].id, openThread.data.id)

	// No filter wipes everything
	const wiped = await api('DELETE', `/files/${reg.id}/comments`)
	t.is(wiped.data.deleted, 1)
	list = await api('GET', `/files/${reg.id}/comments`)
	t.is(list.data.threads.length, 0)

	const unknown = await api('DELETE', '/files/ffffffffff/comments')
	t.is(unknown.status, 404)

	registry.unregister(reg.id)
})

test.serial('comments disappear when the file is unregistered', async t => {
	registry.unregister(fileId)
	const list = await api('GET', `/files/${fileId}/comments`)
	t.is(list.status, 404)
})
