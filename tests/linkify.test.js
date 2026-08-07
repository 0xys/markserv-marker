'use strict'

const test = require('ava')

const {markdownToHTML} = require('../lib/server')

const hrefs = html => [...html.matchAll(/href="([^"]*)"/g)].map(match => match[1])
const textOf = html => html.replaceAll(/<[^>]*>/g, '').trim()

test('a bare URL becomes a link that opens in a new tab', async t => {
	const html = await markdownToHTML('See https://example.com/a?b=1#c for details\n')
	t.deepEqual(hrefs(html), ['https://example.com/a?b=1#c'])
	t.true(html.includes('target="_blank"'))
	t.true(html.includes('rel="noopener noreferrer"'))
})

// Without lib/linkify-cjk.js every one of these swallows the punctuation and
// whatever follows it, because linkify-it does not stop at CJK punctuation
test('a linkified URL stops at CJK punctuation', async t => {
	const cases = [
		['末尾に句点 https://example.com/z。', 'https://example.com/z'],
		['全角括弧（https://example.com/y）です', 'https://example.com/y'],
		['読点 https://example.com/a、そして', 'https://example.com/a'],
		['鍵括弧「https://example.com/b」を', 'https://example.com/b'],
		['疑問 https://example.com/c？', 'https://example.com/c'],
		['中黒 https://example.com/d・e', 'https://example.com/d'],
		['クエリ https://example.com/s?q=1&r=2。', 'https://example.com/s?q=1&amp;r=2']
	]

	const actual = []
	for (const [markdown] of cases) {
		const html = await markdownToHTML(markdown)
		actual.push([markdown, hrefs(html).join(',')])
	}

	t.deepEqual(actual, cases)
})

// Cutting on punctuation and never on word characters is what allows this:
test('a URL whose path is Japanese is left whole', async t => {
	const plain = await markdownToHTML('参照 https://ja.wikipedia.org/wiki/日本語 のこと\n')
	t.deepEqual(hrefs(plain), ['https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC%E8%AA%9E'])

	// Only the trailing 。 comes off, the Japanese path survives
	const punctuated = await markdownToHTML('参照 https://ja.wikipedia.org/wiki/日本語。\n')
	t.deepEqual(hrefs(punctuated), ['https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC%E8%AA%9E'])
})

test('cutting a URL short leaves the visible text untouched', async t => {
	const markdown = '全角括弧（https://example.com/y）です'
	const html = await markdownToHTML(markdown)
	// The characters cut out of the href are handed back to the document, or
	// every comment quote anchored after them would shift
	t.is(textOf(html), markdown)
})

test('file names are not mistaken for hostnames', async t => {
	// .md, .sh and .io are all real TLDs, so guessing would link these
	const html = await markdownToHTML('see README.md, run.sh and deploy.sh\n')
	t.deepEqual(hrefs(html), [])
	t.is(textOf(html), 'see README.md, run.sh and deploy.sh')
})

test('schemeless domains and bare emails stay as text', async t => {
	const html = await markdownToHTML('example.com and www.example.com and foo@example.com\n')
	t.deepEqual(hrefs(html), [])
})

test('URLs inside code are never linkified', async t => {
	const inline = await markdownToHTML('code `https://example.com/c` here\n')
	t.deepEqual(hrefs(inline), [])

	const fence = await markdownToHTML('```\nhttps://example.com/f\n```\n')
	t.deepEqual(hrefs(fence), [])
})

test('URLs the author delimited are untouched', async t => {
	// The markup field is 'linkify' only for what linkify made; it is '' for
	// []() and 'autolink' for <URL>, so these take a different path entirely
	const explicit = await markdownToHTML('[text](https://example.com/keep。)\n')
	t.deepEqual(hrefs(explicit), ['https://example.com/keep%E3%80%82'])

	const autolink = await markdownToHTML('<https://example.com/auto>\n')
	t.deepEqual(hrefs(autolink), ['https://example.com/auto'])
})

test('linkified URLs work inside headings, lists, quotes and tables', async t => {
	const html = await markdownToHTML(
		'# 見出し https://example.com/h\n\n' +
		'- リスト https://example.com/l\n\n' +
		'> 引用 https://example.com/q。\n\n' +
		'| a | b |\n| - | - |\n| https://example.com/t | x |\n')

	t.deepEqual(hrefs(html), [
		'https://example.com/h',
		'https://example.com/l',
		'https://example.com/q',
		'https://example.com/t'
	])
	// Line anchoring is unaffected by the extra inline tokens
	t.true(html.includes('<h1 id='))
	t.true(html.includes('data-source-line'))
})
