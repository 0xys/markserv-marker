'use strict'

const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

const chalk = require('chalk')
const connect = require('connect')
const send = require('send')
const WebSocket = require('ws')
const getPort = require('get-port')
const handlebars = require('handlebars')
const MarkdownIt = require('markdown-it')
const mdItAnchor = require('markdown-it-anchor')
const mdItTaskLists = require('markdown-it-task-lists')
const mdItHLJS = require('markdown-it-highlightjs')
const mdItTOC = require('markdown-it-table-of-contents')
// The emoji plugin exports its sets by name since 3.x; full is what 1.x was
const {full: mdItEmoji} = require('markdown-it-emoji')
const mdItMathJax = require('markdown-it-mathjax')
const emojiRegex = require('emoji-regex')()

const registry = require('./registry')
const sourceLine = require('./source-line')
const mermaidFences = require('./mermaid')
const diffFences = require('./diff-fence')
const linkifyCjk = require('./linkify-cjk')
const createApiHandler = require('./api')
const security = require('./security')
const {fileTypes, isType} = require('./file-types')

const pkg = require('../package.json')

const style = {
	link: chalk.blueBright.underline.italic,
	address: chalk.greenBright.underline.italic,
	port: chalk.reset.cyanBright,
	pid: chalk.reset.cyanBright
}

const slugify = text => text.toLowerCase().replaceAll(/\s/g, '-')
// Remove punctuations other than hyphen and underscore
	.replaceAll(/[`~!@#$%^&*()+=<>?,./:;"'|{}[\]\\\u2000-\u206F\u2E00-\u2E7F]/g, '')
// Remove emojis
	.replace(emojiRegex, '')
// Remove CJK punctuations
	.replaceAll(/[\u3000。？！，、；：“”【】（）〔〕［］﹃﹄‘’﹁﹂—…－～《》〈〉「」]/g, '')

// External links open in a new tab; relative links and anchors stay in-tab
const externalLinks = markdownIt => {
	const defaultRender = markdownIt.renderer.rules.link_open ||
		((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))

	// eslint-disable-next-line camelcase -- markdown-it rule name
	markdownIt.renderer.rules.link_open = (tokens, idx, options, env, self) => {
		const href = tokens[idx].attrGet('href') || ''
		if (/^https?:\/\//i.test(href)) {
			tokens[idx].attrSet('target', '_blank')
			tokens[idx].attrSet('rel', 'noopener noreferrer')
		}

		return defaultRender(tokens, idx, options, env, self)
	}
}

// Version 1.x of markdown-it-emoji pushed its core rule, so it ran after anchor
// and a heading's id was slugged from its :shortcode: text. 3.x inserts the
// rule after linkify instead, ahead of anchor, which turns "Plan :rocket:" into
// the id plan- while the TOC, which reads the source, still links to
// plan-rocket. Ruler has no public way to move a rule, so it is put back right
// after anchor, where 1.x left it.
const emojiAfterAnchor = markdownIt => {
	const rules = markdownIt.core.ruler.__rules__
	const [emoji] = rules.splice(rules.findIndex(rule => rule.name === 'emoji'), 1)
	rules.splice(rules.findIndex(rule => rule.name === 'anchor') + 1, 0, emoji)
	markdownIt.core.ruler.__cache__ = null
}

const md = new MarkdownIt({
	linkify: true,
	html: true
})
	.use(mdItAnchor, {slugify})
	.use(mdItTaskLists)
	.use(mdItHLJS)
	.use(mdItEmoji)
	// Moves the emoji rule back behind anchor, where 1.x of the plugin ran
	.use(emojiAfterAnchor)
	.use(mdItMathJax())
	.use(mdItTOC, {
		includeLevel: [1, 2, 3, 4, 5, 6],
		slugify
	})
	.use(externalLinks)
	// After highlightjs, whose fence renderer it wraps
	.use(sourceLine)
	// After sourceLine, whose fence renderer it wraps in turn
	.use(mermaidFences)
	// After mermaid, so that plugin still wraps the renderer it expects
	.use(diffFences)
	// Corrects where linkify decides a URL ends in Japanese prose
	.use(linkifyCjk)

// Building a fence token by hand is how a .diff file reuses the fence
// renderer. markdown-it 15 exports no lib/ paths, so the class is taken from
// a core state, which carries it as an instance field.
const {Token} = new md.core.State('', md, {})

// Only URLs carrying a scheme become links. Left to guess, linkify reads
// README.md as a hostname and links it to http://README.md — and .md, .sh and
// .io are all real TLDs, so a document that names files would be full of them.
// Bare email addresses stay as text for the same reason: nobody asked for them
// to be actionable.
md.linkify.set({fuzzyLink: false, fuzzyEmail: false})

const materialIcons = require(path.join(__dirname, 'icons', 'material-icons.json'))

const faviconPath = path.join(__dirname, 'icons', 'markserv.svg')
const faviconData = fs.readFileSync(faviconPath)

const log = (str, flags, err) => {
	if (flags.silent) {
		return
	}

	if (str) {
		console.log(str)
	}

	if (err) {
		console.error(err)
	}
}

const msg = (type, msg, flags) =>
	log(chalk`{bgGreen.black   Marker  }{white  ${type}: }` + msg, flags)

const errormsg = (type, msg, flags, err) =>
	log(chalk`{bgRed.white   Marker  }{red  ${type}: }` + msg, flags, err)

// YAML frontmatter at the very start of a file: --- ... ---
const frontmatterRe = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/

// MarkdownToHTML: turns a Markdown file into HTML content. Frontmatter is
// rendered as a collapsible block instead of being parsed as markdown
// (where the closing --- would turn the last line into a giant heading).
const markdownToHTML = async markdownText => {
	const match = markdownText.match(frontmatterRe)
	if (!match) {
		return md.render(markdownText)
	}

	// Replace the frontmatter with the same number of blank lines so that
	// data-source-line numbers (and thus comment anchors) stay accurate
	const lineCount = match[0].split('\n').length - 1
	const body = '\n'.repeat(lineCount) + markdownText.slice(match[0].length)

	const frontmatterHtml =
		`<details class="frontmatter" open data-source-line="1" data-source-line-end="${lineCount}">` +
		'<summary>frontmatter</summary>' +
		`<pre><code>${md.utils.escapeHtml(match[1])}</code></pre></details>\n`

	return frontmatterHtml + md.render(body)
}

// DiffToHTML: turns a .diff or .patch file into the same block a ```diff fence
// renders as. Built by handing the real fence renderer a token rather than
// emitting the markup here, so the two paths cannot drift apart: the wrapper,
// the highlighting and the line attributes all arrive from the plugin chain.
//
// The whole file is one block starting at line 1, which is what keeps the
// stamped numbers equal to the file's own. Wrapping the content in a synthetic
// fence and parsing that would put every line out by one, and registry.js
// reads the real file to narrow a comment's range.
const diffToHTML = diffText => {
	const count = Math.max(1, diffText.replace(/\n$/, '').split('\n').length)
	const token = new Token('fence', '', 0)
	token.info = 'diff'
	token.content = diffText.endsWith('\n') ? diffText : diffText + '\n'
	// The <pre> takes its attributes from the map, the <code> from these
	token.map = [0, count]
	token.attrSet('data-source-line', '1')
	token.attrSet('data-source-line-end', String(count))

	return md.renderer.rules.fence([token], 0, md.options, {}, md.renderer)
}

// GetFile: reads utf8 content from a file
const getFile = path => fs.promises.readFile(path, 'utf8')

// The index page lists file names, and a tree of index.md files all look the
// same there. The document's own title tells them apart, so it is read off the
// head of the file: a frontmatter `title:` wins, otherwise the first heading.
// Only the head is read — something this far down is not the document's title,
// and the index should not pay to read whole files to draw one column.
const TITLE_SCAN_BYTES = 8192
const TITLE_MAX_CHARS = 120

const tidyTitle = text => text
	.replaceAll(/\[([^\]]+)]\([^)]*\)/g, '$1') // Links keep their text
	.replaceAll('`', '')
	.replaceAll(/[*_]{1,3}(.+?)[*_]{1,3}/g, '$1') // Emphasis markers
	.replaceAll(/\s+/g, ' ')
	.trim()
	.slice(0, TITLE_MAX_CHARS)

const readHead = filePath => {
	const fd = fs.openSync(filePath, 'r')
	try {
		const buffer = Buffer.alloc(TITLE_SCAN_BYTES)
		const read = fs.readSync(fd, buffer, 0, TITLE_SCAN_BYTES, 0)
		const head = buffer.subarray(0, read).toString('utf8')
		// A full buffer means the last line was probably cut, possibly
		// mid-character, so it is not trustworthy
		return read < TITLE_SCAN_BYTES ? head : head.slice(0, head.lastIndexOf('\n') + 1)
	} finally {
		fs.closeSync(fd)
	}
}

const readMarkdownTitle = filePath => {
	if (!isType(fileTypes.markdown, filePath)) {
		return null
	}

	let head
	try {
		head = readHead(filePath)
	} catch {
		// Deleted, unreadable, a directory — the index still has to render
		return null
	}

	const frontmatter = head.match(frontmatterRe)
	if (frontmatter) {
		const declared = frontmatter[1].match(/^title\s*:\s*(.+)$/m)
		if (declared) {
			const value = tidyTitle(declared[1].replaceAll(/^["']|["']$/g, ''))
			if (value) {
				return value
			}
		}
	}

	const lines = (frontmatter ? head.slice(frontmatter[0].length) : head).split(/\r?\n/)
	let inFence = false
	for (const [index, raw] of lines.entries()) {
		const line = raw.trim()
		// A '# comment' inside a fenced block is not a heading
		if (/^(```|~~~)/.test(line)) {
			inFence = !inFence
			continue
		}

		if (inFence || !line) {
			continue
		}

		const atx = line.match(/^#\s+(.+?)\s*#*$/)
		if (atx) {
			return tidyTitle(atx[1]) || null
		}

		// Setext heading: the text is underlined with ===
		if (/^=+$/.test((lines[index + 1] || '').trim())) {
			return tidyTitle(line) || null
		}
	}

	return null
}

const baseTemplate = (templateUrl, handlebarData) => new Promise((resolve, reject) => {
	getFile(templateUrl).then(source => {
		const template = handlebars.compile(source)
		const output = template(handlebarData)
		resolve(output)
	}).catch(reject)
})

const lookUpIconClass = (path, type) => {
	let iconDef

	if (type === 'folder') {
		iconDef = materialIcons.folderNames[path]

		iconDef ||= 'folder'
	}

	if (type === 'file') {
		// Try extensions first
		const ext = path.slice(path.lastIndexOf('.') + 1)
		iconDef = materialIcons.fileExtensions[ext]

		// Then try applying the filename
		iconDef ||= materialIcons.fileNames[path]

		iconDef ||= 'file'
	}

	return iconDef
}

const dirToHtml = filePath => {
	const urls = fs.readdirSync(filePath)

	let list = '<ul>\n'

	for (const subPath of urls) {
		// Secrets are left out with the rest of the dot entries, and so are
		// the few that need no dot, such as a private key or a .pem
		if (subPath.charAt(0) === '.' || security.isSecretName(subPath)) {
			continue
		}

		// A file name is whatever its author chose, and on macOS or Linux that
		// can be markup: both the link and its text are escaped
		const dir = fs.statSync(path.join(filePath, subPath)).isDirectory()
		const text = md.utils.escapeHtml(dir ? subPath + '/' : subPath)
		const href = md.utils.escapeHtml(encodeURIComponent(subPath) + (dir ? '/' : ''))
		if (dir) {
			list += `\t<li class="icon folder isfolder"><a href="${href}">${text}</a></li> \n`
		} else {
			const iconClass = md.utils.escapeHtml(lookUpIconClass(subPath, 'file'))
			list += `\t<li class="icon ${iconClass} isfile"><a href="${href}">${text}</a></li> \n`
		}
	}

	list += '</ul>\n'

	return list
}

// Remove URL params from file being fetched
const getPathFromUrl = url => url.split(/[?#]/)[0]

const secureUrl = url => {
	const encodedUrl = encodeURI(url.replaceAll('%', '%25'))
	return encodedUrl
}

// Create breadcrumb trail tracks, rooted at a registration's URL prefix
const createBreadcrumbs = (relPath, basePrefix, rootLabel) => {
	const crumbs = [{
		href: basePrefix,
		text: rootLabel
	}]

	const dirParts = relPath.replaceAll(/(^\/+|\/+$)/g, '').split('/')
	const urlParts = dirParts.map(part => secureUrl(part))

	if (relPath.length === 0) {
		return crumbs
	}

	let collectPath = basePrefix

	for (const [i, dirName] of dirParts.entries()) {
		const fullLink = collectPath + urlParts[i] + '/'

		const crumb = {
			href: fullLink,
			text: dirName + '/'
		}

		crumbs.push(crumb)
		collectPath = fullLink
	}

	return crumbs
}

const resolveTheme = flags => {
	if (flags.light) {
		return 'light'
	}

	if (flags.synthwave) {
		return 'synthwave'
	}

	if (flags.theme && flags.theme !== 'dark') {
		return flags.theme
	}

	return 'dark'
}

// Resolve a URL path against a root directory, refusing anything that
// escapes the root (path traversal) or smuggles null bytes.
const resolveWithin = (root, urlPath) => {
	if (urlPath.includes('\0')) {
		return null
	}

	const resolved = path.resolve(root, urlPath.replace(/^\/+/, ''))
	if (resolved === root || resolved.startsWith(root + path.sep)) {
		return resolved
	}

	return null
}

// Whether a path resolved under a registration may be served, or why not.
// resolveWithin only looked at the name: the file it names can still be a
// secret, or a symlink to anywhere on the disk, and a registration exposes
// every file beside the one the user asked for. The registered file itself is
// always served, being the one thing the user did name.
const servingRefusal = (reg, filePath, flags) => {
	if (filePath === reg.path) {
		return null
	}

	if (security.isSecretPath(reg.root, filePath)) {
		return {status: 404}
	}

	let real
	try {
		real = fs.realpathSync(filePath)
	} catch {
		// Missing: the caller's own stat reports that
		return null
	}

	if (real === reg.path) {
		return null
	}

	// The root is a realpath already, made so by registry.register
	if (real !== reg.root && !real.startsWith(reg.root + path.sep)) {
		if (!flags.followSymlinks) {
			return {
				status: 403,
				message: 'This path leads out of the served root through a symlink — ' +
					'start the daemon with --follow-symlinks to serve it'
			}
		}

		return security.isSecretName(path.basename(real)) ? {status: 404} : null
	}

	// A symlink inside the root can still point at its .git
	return security.isSecretPath(reg.root, real) ? {status: 404} : null
}

// A refused secret and a file that is not there get the same page. Made here
// rather than taken from fs, because the stack of a real ENOENT would tell
// the two apart.
const notFound = filePath => {
	const error = new Error(`No such file or directory: ${filePath}`)
	error.stack = error.message
	return error
}

const markservUrlLead = '%7Bmarkserv%7D'

// A malformed escape in a URL is the client's mistake, not a 500 carrying a
// stack trace
const safeDecode = text => {
	try {
		return decodeURIComponent(text)
	} catch {
		return null
	}
}

// Streams a file with `send`, which expects a URL-encoded path relative to root
const sendFile = (req, res, root, absPath, options = {}) => {
	if (options.sandbox) {
		res.setHeader('Content-Security-Policy', security.RAW_FILE_POLICY)
	}

	const urlPath = path.relative(root, absPath)
		.split(path.sep)
		.map(segment => encodeURIComponent(segment))
		.join('/')

	const {sandbox, ...sendOptions} = options
	send(req, urlPath, {root, ...sendOptions}).pipe(res)
}

// Serves markserv-marker's own bundled assets ({markserv}templates/... URLs)
const createAssetHandler = flags => (req, res, next) => {
	if (!req.url.includes(markservUrlLead)) {
		return next()
	}

	const assetPath = safeDecode(getPathFromUrl(req.url.split(markservUrlLead)[1]))
	const assetFilePath = assetPath === null ? null : resolveWithin(__dirname, assetPath)

	if (!assetFilePath) {
		res.writeHead(403)
		res.end()
		return
	}

	if (flags.verbose) {
		msg('{markserv url}', style.link(assetFilePath), flags)
	}

	sendFile(req, res, __dirname, assetFilePath)
}

const createHandlers = flags => {
	const theme = resolveTheme(flags)
	const themeFlags = {
		themeDark: theme === 'dark',
		themeLight: theme === 'light',
		themeSynthwave: theme === 'synthwave',
		themeSolarized: theme === 'solarized'
	}

	// Read per page rather than once, since the hot-reload port is only known
	// after the HTTP server is listening
	const commonTemplateData = () => ({
		pid: process.pid,
		// Every footer names the version, so it belongs here rather than to
		// the one page that used to
		version: pkg.version,
		theme,
		...themeFlags,
		hotreload: flags.$hotreload,
		wsPort: flags.$wsPort
	})

	// Every page this daemon renders goes out under a policy naming a nonce of
	// its own, which every <script> in the templates carries
	const sendPage = (res, status, templateUrl, handlebarData) => {
		const nonce = security.newNonce()
		return baseTemplate(templateUrl, {...handlebarData, nonce}).then(final => {
			res.writeHead(status, {
				'content-type': 'text/html; charset=utf-8',
				'content-security-policy': security.pagePolicy(nonce)
			})
			res.end(final)
		})
	}

	const errorPage = (res, code, filePath, err, referer) => {
		errormsg(code, filePath, flags, err)

		const templateUrl = path.join(__dirname, 'templates/error.html')

		const handlebarData = {
			...commonTemplateData(),
			code,
			fileName: path.parse(filePath).base,
			filePath,
			// The stack goes to the daemon's log above, never to the page: it
			// names the daemon's own install path and the reader's home with it
			errorMsg: md.utils.escapeHtml(err.message),
			referer: referer || '/',
			rootDir: filePath
		}

		return sendPage(res, code, templateUrl, handlebarData)
	}

	const sendFavicon = res => {
		res.writeHead(200, {'Content-Type': 'image/svg+xml'})
		res.write(faviconData)
		res.end()
	}

	// Comments hang off a registration, whose comment store and snapshot base
	// are one single file (reg.comments / reg.path). A markdown file reached
	// through a directory registration — or through a sibling link under
	// another file's registration — therefore has nowhere to put comments, so
	// it gets a registration of its own here. register() derives its id from
	// the realpath and is idempotent, so revisiting a file reuses it. The URL
	// stays under the registration the reader came in through, keeping
	// breadcrumbs and relative links intact.
	const commentIdFor = (reg, filePath) => {
		if (filePath === reg.path) {
			return reg.id
		}

		try {
			return registry.register(filePath).reg.id
		} catch (error) {
			// A render must not fail because the file could not be registered
			errormsg('register', filePath, flags, error)
			return false
		}
	}

	// A .diff file goes through the same page as markdown: same template, same
	// comment UI, only the content builder differs
	const renderDocument = (kind, toHtml) => (reg, filePath, res) => {
		msg(kind, style.link(filePath), flags)

		return getFile(filePath).then(toHtml).then(content => {
			const templateUrl = path.join(__dirname, 'templates/markdown.html')

			const handlebarData = {
				...commonTemplateData(),
				title: path.parse(filePath).base,
				content,
				rootDir: reg.root,
				fileId: commentIdFor(reg, filePath),
				filePath,
				fileUrl: reg.urlPath
			}

			return sendPage(res, 200, templateUrl, handlebarData)
		})
	}

	const renderMarkdown = renderDocument('markdown', markdownToHTML)
	const renderDiff = renderDocument('diff', diffToHTML)

	const renderDirectory = (reg, filePath, res) => {
		msg('dir', style.link(filePath), flags)

		const templateUrl = path.join(__dirname, 'templates/directory.html')
		const basePrefix = `/f/${reg.id}/`

		const handlebarData = {
			...commonTemplateData(),
			dirname: path.parse(filePath).dir,
			content: dirToHtml(filePath),
			title: path.parse(filePath).base,
			// The strip above the page frame names this folder
			filePath,
			// The served root is the folder itself, which for a file
			// registration is the file's parent: labelling it reg.name gave the
			// folder the file's name, and the path strip now links here
			breadcrumbs: createBreadcrumbs(path.relative(reg.root, filePath), basePrefix,
				(path.parse(reg.root).base || reg.root) + '/'),
			rootDir: reg.root
		}

		return sendPage(res, 200, templateUrl, handlebarData)
	}

	// Handles /f/<id>/<path-within-root>
	const fileHandler = (req, res) => {
		const decoded = safeDecode(req.url)
		if (decoded === null) {
			res.writeHead(400, {'content-type': 'text/plain; charset=utf-8'})
			res.end('Malformed URL\n')
			return
		}

		const decodedUrl = getPathFromUrl(decoded)
		const match = decodedUrl.match(/^\/([^/]+)(\/.*)?$/)

		if (!match) {
			res.writeHead(302, {Location: '/'})
			res.end()
			return
		}

		const reg = registry.get(match[1])
		if (!reg) {
			return errorPage(res, 404, decodedUrl,
				new Error(`Not registered with this daemon: ${match[1]} — see the index at /`))
		}

		const rest = match[2] || '/'
		const filePath = resolveWithin(reg.root, rest)
		if (!filePath) {
			return errorPage(res, 403, decodedUrl,
				new Error('Path escapes the served root directory'))
		}

		if (flags.verbose) {
			msg('request', filePath, flags)
		}

		const back = path.parse(req.originalUrl).dir + '/'
		const refusal = servingRefusal(reg, filePath, flags)
		if (refusal) {
			return errorPage(res, refusal.status, filePath,
				refusal.message ? new Error(refusal.message) : notFound(filePath), back)
		}

		let stat
		try {
			stat = fs.statSync(filePath)
		} catch (error) {
			if (path.parse(filePath).base === 'favicon.ico') {
				return sendFavicon(res)
			}

			const missing = error.code === 'ENOENT' || error.code === 'ENOTDIR'
			return errorPage(res, 404, filePath, missing ? notFound(filePath) : error, back)
		}

		if (stat.isDirectory()) {
			if (!decodedUrl.endsWith('/')) {
				res.writeHead(301, {Location: getPathFromUrl(req.originalUrl) + '/'})
				res.end()
				return
			}

			return renderDirectory(reg, filePath, res)
				.catch(error => errorPage(res, 500, filePath, error))
		}

		if (isType(fileTypes.markdown, filePath)) {
			return renderMarkdown(reg, filePath, res)
				.catch(error => errorPage(res, 500, filePath, error))
		}

		if (isType(fileTypes.diff, filePath)) {
			return renderDiff(reg, filePath, res)
				.catch(error => errorPage(res, 500, filePath, error))
		}

		if (isType(fileTypes.html, filePath)) {
			msg('html', style.link(filePath), flags)
			return getFile(filePath).then(html => {
				res.writeHead(200, {
					'content-type': 'text/html; charset=utf-8',
					'content-security-policy': security.RAW_FILE_POLICY
				})
				res.end(html)
			}).catch(error => errorPage(res, 500, filePath, error))
		}

		msg('file', style.link(filePath), flags)
		sendFile(req, res, reg.root, filePath, {dotfiles: 'allow', sandbox: true})
	}

	// Handles everything else: the index page at '/', favicon, 404s
	const indexHandler = (req, res) => {
		const pathname = getPathFromUrl(req.url)

		if (pathname === '/favicon.ico') {
			return sendFavicon(res)
		}

		if (pathname !== '/' && pathname !== '') {
			return errorPage(res, 404, pathname,
				new Error('Not found — the daemon only serves registered files (see the index at /)'))
		}

		const allFiles = registry.list()
			.sort((a, b) => (a.registeredAt < b.registeredAt ? 1 : -1))
			.map(reg => ({
				id: reg.id,
				name: reg.name,
				path: reg.path,
				urlPath: reg.urlPath,
				registeredAt: reg.registeredAt,
				iconClass: reg.type === 'dir' ? 'folder' : lookUpIconClass(reg.name, 'file'),
				isDir: reg.type === 'dir',
				comments: registry.commentCounts(reg.id)
			}))

		const pageSize = 20
		const totalPages = Math.max(1, Math.ceil(allFiles.length / pageSize))
		const requestedPage = Number.parseInt(
			new URL(req.url, 'http://localhost').searchParams.get('page'), 10)
		const page = Math.min(totalPages, Math.max(1, requestedPage || 1))
		// Titles are read from disk, so only the rows actually on this page
		const files = allFiles.slice((page - 1) * pageSize, page * pageSize)
			.map(file => ({
				...file,
				title: file.isDir ? null : readMarkdownTitle(file.path)
			}))

		const templateUrl = path.join(__dirname, 'templates/index.html')
		const handlebarData = {
			...commonTemplateData(),
			title: 'markserv-marker',
			port: flags.$httpPort,
			files,
			hasFiles: allFiles.length > 0,
			totalFiles: allFiles.length,
			page,
			totalPages,
			paged: totalPages > 1,
			hasPrev: page > 1,
			hasNext: page < totalPages,
			prevPage: page - 1,
			nextPage: page + 1,
			rootDir: 'index'
		}

		return sendPage(res, 200, templateUrl, handlebarData)
			.catch(error => errorPage(res, 500, pathname, error))
	}

	return {fileHandler, indexHandler, errorPage}
}

const probeExistingDaemon = (port, flags) => {
	const fail = () => {
		errormsg('port', `port ${port} is in use by another service — choose a different --port`, flags)
		process.exit(1)
	}

	const request = http.get({
		host: loopbackHosts(flags.address)[0], port, path: '/api/health', timeout: 1000
	}, res => {
		let data = ''
		res.on('data', chunk => {
			data += chunk
		})
		res.on('end', () => {
			try {
				if (JSON.parse(data).name === pkg.name) {
					msg('daemon', `already running on port ${port} — exiting`, flags)
					process.exit(0)
				}
			} catch {}

			fail()
		})
	})

	request.on('error', fail)
	request.on('timeout', () => {
		request.destroy()
		fail()
	})
}

// "localhost" names two addresses and a client may try either: Node resolved
// it to ::1 alone, so http://127.0.0.1:7642 found nothing listening, while a
// browser or curl may well pick 127.0.0.1. Both are bound, by the HTTP server
// and the hot-reload socket alike; a machine without IPv6 simply has the one.
// Any other address is bound as given.
const loopbackHosts = address =>
	(!address || address === 'localhost') ? ['127.0.0.1', '::1'] : [address]

const listenOn = (server, port, host) => new Promise((resolve, reject) => {
	const onError = error => {
		server.removeListener('listening', onListening)
		reject(error)
	}

	const onListening = () => {
		server.removeListener('error', onError)
		resolve()
	}

	server.once('error', onError)
	server.once('listening', onListening)
	server.listen(port, host)
})

const NO_IPV6 = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT'])

// Binds one server per address on the same port, or none at all: a failure on
// any address closes the ones already bound and is rethrown. ::1 may be
// missing when it is one of several, never when it was asked for alone.
const listenAll = async (port, hosts, createServer) => {
	const servers = []
	try {
		for (const host of hosts) {
			const server = createServer()
			await listenOn(server, port, host).then(() => servers.push(server), error => {
				if (hosts.length === 1 || host !== '::1' || !NO_IPV6.has(error.code)) {
					throw error
				}
			})
		}
	} catch (error) {
		for (const server of servers) {
			server.close()
		}

		throw error
	}

	return servers
}

// The port is only free on the addresses get-port happened to probe, and a
// second address can find it taken, so a clash moves every address on to a
// fresh port together
const bindHotReload = async (firstPort, flags, onUpgrade) => {
	let port = firstPort
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			const createServer = () => http.createServer((req, res) => {
				res.writeHead(426, {'content-type': 'text/plain; charset=utf-8'})
				res.end('WebSocket only\n')
			}).on('upgrade', onUpgrade)
			return {servers: await listenAll(port, loopbackHosts(flags.address), createServer), port}
		} catch (error) {
			if (error.code !== 'EADDRINUSE') {
				throw error
			}
		}

		port = await getPort()
	}

	throw new Error('No free port for the hot-reload server')
}

// The same addresses as the socket, one HTTP server on each
const startHTTPServer = async (connectApp, port, flags) => {
	try {
		return await listenAll(port, loopbackHosts(flags.address), () => http.createServer(connectApp))
	} catch (error) {
		if (error.code === 'EADDRINUSE' && flags.$exitOnAddrInUse) {
			// Two CLIs raced to start the daemon: if the winner is one of us,
			// bow out quietly so both CLI health polls succeed against it.
			// The probe exits the process either way.
			probeExistingDaemon(port, flags)
			return new Promise(() => {})
		}

		throw error
	}
}

const startHotReload = async (firstPort, flags) => {
	// A viewer sends one short JSON message naming its page; ws would
	// otherwise buffer up to 100 MB of whatever a client cares to send
	const wss = new WebSocket.Server({noServer: true, maxPayload: 64 * 1024})
	const clients = new Map()

	const onUpgrade = (req, socket, head) => {
		if (!security.upgradeAllowed(req, flags)) {
			socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
			return
		}

		wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
	}

	const {servers, port} = await bindHotReload(firstPort, flags, onUpgrade)

	// The path is whatever the client sent; a malformed escape in it must not
	// throw from inside the watcher callback, which would take the daemon down
	const parseClientPath = clientPath => {
		if (typeof clientPath !== 'string') {
			return null
		}

		const match = getPathFromUrl(clientPath).match(/^\/f\/([^/]+)(\/.*)?$/)
		if (!match) {
			return null
		}

		try {
			return {id: match[1], rest: decodeURIComponent(match[2] || '/')}
		} catch {
			return null
		}
	}

	// Which registration a viewer's comments live under. Usually the id in its
	// URL, but a markdown file reached through a directory registration is
	// commented on under its own registration, so the page reports that id.
	const commentIds = new Map()

	wss.on('connection', ws => {
		// A malformed or oversized frame is reported as an error on the socket,
		// and an EventEmitter with no listener for it throws — which, from a
		// socket callback, takes the whole daemon down. ws closes the
		// connection itself; there is nothing more to do here.
		ws.on('error', () => {})

		ws.on('message', data => {
			try {
				const msg_ = JSON.parse(data)
				if (msg_.path) {
					clients.set(ws, msg_.path)
				}

				if (msg_.fileId) {
					commentIds.set(ws, msg_.fileId)
				}
			} catch {}
		})

		ws.on('close', () => {
			clients.delete(ws)
			commentIds.delete(ws)
		})
	})

	const sendToClient = (ws, payload) => {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(payload))
		}
	}

	const broadcastComments = fileId => {
		for (const [ws, clientPath] of clients) {
			const parsed = parseClientPath(clientPath)
			const viewing = commentIds.get(ws) || (parsed && parsed.id)
			if (viewing === fileId) {
				sendToClient(ws, {type: 'comments', fileId})
			}
		}
	}

	const rerenderClient = (ws, reg, rest) => {
		const filePath = resolveWithin(reg.root, rest)
		if (!filePath || servingRefusal(reg, filePath, flags)) {
			return
		}

		let stat
		try {
			stat = fs.statSync(filePath)
		} catch {
			return
		}

		const toHtml = stat.isDirectory() ?
			null :
			(isType(fileTypes.markdown, filePath) && markdownToHTML) ||
			(isType(fileTypes.diff, filePath) && diffToHTML)

		if (toHtml) {
			getFile(filePath)
				.then(toHtml)
				.then(html => sendToClient(ws, {type: 'reload', html}))
				.catch(error => errormsg('hotreload', filePath, flags, error))
		} else if (stat.isDirectory()) {
			try {
				const content = dirToHtml(filePath)
				const breadcrumbs = createBreadcrumbs(
					path.relative(reg.root, filePath), `/f/${reg.id}/`, reg.name + '/')
				let headerHtml = '<h1 class="icon folder isfolder">'
				for (const crumb of breadcrumbs) {
					headerHtml += `<a href="${md.utils.escapeHtml(crumb.href)}">${md.utils.escapeHtml(crumb.text)}</a>`
				}

				headerHtml += '</h1>\n'
				const footerHtml = '<footer><sup><hr> Served by <a href="https://github.com/markserv/markserv" target="_blank" rel="noopener noreferrer">markserv</a>-marker | <a href="/">index</a> | PID: ' + process.pid + '</sup></footer>'
				sendToClient(ws, {type: 'reload', html: headerHtml + content + footerHtml})
			} catch (error) {
				errormsg('hotreload', filePath, flags, error)
			}
		}
	}

	const handleChange = root => {
		for (const [ws, clientPath] of clients) {
			if (ws.readyState !== WebSocket.OPEN) {
				continue
			}

			const parsed = parseClientPath(clientPath)
			if (!parsed) {
				continue
			}

			const reg = registry.get(parsed.id)
			if (!reg || reg.root !== root) {
				continue
			}

			rerenderClient(ws, reg, parsed.rest)
		}
	}

	// One recursive watcher per registration root, refcounted because several
	// files can be registered out of the same directory
	const watchers = new Map()

	const addRoot = root => {
		const existing = watchers.get(root)
		if (existing) {
			existing.count++
			return
		}

		const entry = {count: 1, timer: null, watcher: null}

		try {
			entry.watcher = fs.watch(root, {recursive: true}, (eventType, filename) => {
				if (!filename) {
					return
				}

				for (const exclusion of fileTypes.exclusions) {
					if (filename.includes(exclusion.replace(/\/$/, ''))) {
						return
					}
				}

				const ext = path.extname(filename)
				if (ext && !fileTypes.watch.includes(ext)) {
					return
				}

				clearTimeout(entry.timer)
				entry.timer = setTimeout(() => handleChange(root), 150)
			})
		} catch (error) {
			errormsg('watch', root, flags, error)
			return
		}

		watchers.set(root, entry)
	}

	const removeRoot = root => {
		const entry = watchers.get(root)
		if (!entry) {
			return
		}

		entry.count--
		if (entry.count <= 0) {
			clearTimeout(entry.timer)
			entry.watcher.close()
			watchers.delete(root)
		}
	}

	const onRegister = reg => addRoot(reg.root)
	const onUnregister = reg => removeRoot(reg.root)

	for (const reg of registry.list()) {
		addRoot(reg.root)
	}

	registry.events.on('register', onRegister)
	registry.events.on('unregister', onUnregister)

	const close = () => {
		registry.events.removeListener('register', onRegister)
		registry.events.removeListener('unregister', onUnregister)
		for (const entry of watchers.values()) {
			clearTimeout(entry.timer)
			entry.watcher.close()
		}

		watchers.clear()
		wss.close()
		for (const server of servers) {
			server.close()
		}
	}

	return {
		wss, port, broadcastComments, close
	}
}

const logActiveServerInfo = (serveURL, wsPort, flags) => {
	msg('address', style.address(serveURL), flags)

	if (wsPort) {
		msg('hotreload', chalk`{grey ws://localhost:${style.port(wsPort)}}`, flags)
	}

	msg('process', chalk`{grey pid: ${style.pid(process.pid)}}`, flags)
	msg('stop', chalk`{grey POST ${serveURL}/api/shutdown or "markserv-marker stop"}`, flags)
}

const init = async flags => {
	const httpPort = Number(flags.port) || 7642
	flags.$httpPort = httpPort

	const hotreloadEnabled = flags.hotreload !== false && flags.hotreload !== 'false'
	flags.$hotreload = hotreloadEnabled

	const startedAt = new Date().toISOString()
	const notify = {
		commentChange() {}
	}

	const apiHandler = createApiHandler({
		flags,
		pkg,
		startedAt,
		notify,
		onShutdown: flags.$onShutdown || (() => process.exit(0))
	})

	const {fileHandler, indexHandler} = createHandlers(flags)

	const connectApp = connect()
		.use(security.createRequestGuard(flags))
		.use(createAssetHandler(flags))
		.use('/api', security.createApiGuard(flags))
		.use('/api', apiHandler)
		.use('/f', fileHandler)
		.use('/', indexHandler)

	// The HTTP port first: it is the one the user asked for, and a daemon that
	// loses the race to start goes no further than this. The socket takes the
	// next free port after it, which every page then names.
	const httpServers = await startHTTPServer(connectApp, httpPort, flags)

	let hotReload = null
	if (hotreloadEnabled) {
		try {
			hotReload = await startHotReload(await getPort({port: httpPort + 1}), flags)
		} catch (error) {
			for (const httpServer of httpServers) {
				httpServer.close()
			}

			throw error
		}
	}

	const wsPort = hotReload ? hotReload.port : null
	flags.$wsPort = wsPort

	if (hotReload) {
		notify.commentChange = hotReload.broadcastComments
	}

	const serveURL = 'http://' + flags.address + ':' + httpPort

	logActiveServerInfo(serveURL, wsPort, flags)

	const service = {
		pid: process.pid,
		httpServer: httpServers[0],
		httpServers,
		hotReloadServer: hotReload ? hotReload.wss : null,
		wsPort,
		connectApp,
		serveURL,
		registry,
		notifyCommentChange: fileId => notify.commentChange(fileId),
		close() {
			if (hotReload) {
				hotReload.close()
			}

			for (const httpServer of httpServers) {
				httpServer.close()
			}
		}
	}

	return service
}

module.exports = {
	getFile,
	markdownToHTML,
	diffToHTML,
	init
}
