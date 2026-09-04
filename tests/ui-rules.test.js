'use strict'

// Rules that live in stylesheets and the page template, which jsdom cannot
// exercise: each of these was a bug seen in a browser, and each is one
// deletion away from coming back.

const fs = require('node:fs')
const path = require('node:path')
const test = require('ava')

const read = name => fs.readFileSync(path.join(__dirname, '..', 'lib', 'templates', name), 'utf8')

test('the snapshot diff table is styled against the theme, not alone', t => {
	const css = read('comments.css').replaceAll(/\/\*[\s\S]*?\*\//g, '')
	// Every selector laying out the diff table or its rows has to outrank
	// `.markdown-body table…`, or the theme's block display, padding,
	// borders and zebra rows take it over. The cells' colour rules paint the
	// cell itself, which no row rule reaches, and may stay bare.
	const selectors = [...css.matchAll(/^([^{}\n][^{}]*?)\s*{/gm)]
		.map(m => m[1].trim())
		.filter(selector => /marker-diff-(table|row)/.test(selector))
	t.true(selectors.length >= 3)
	for (const selector of selectors) {
		t.true(selector.startsWith('.markdown-body '), `${selector} is not written against the theme`)
	}

	t.true(css.includes('.markdown-body .marker-diff-table td.marker-diff-cell {'))
})

test('block toggles cannot take the endpoint of a selection', t => {
	for (const [file, className] of [['mermaid.css', 'marker-mermaid-toggle'], ['diff-block.css', 'marker-diffblock-toggle']]) {
		const css = read(file)
		const block = css.match(new RegExp('\\.' + className + '\\s*\\{([^}]*)\\}'))
		t.truthy(block, `${file} has no toggle rule`)
		t.regex(block[1], /user-select:\s*none/, `${file} toggle is selectable`)
	}
})

test('table stripes are counted among the table\'s own rows', t => {
	const css = read('markserv.css')
	t.true(css.includes('> tbody > tr:nth-child(2n of :not([data-marker-ui]))'))
	// And never the rows of the snapshot diff, which sit inside a widget in a tbody
	t.true(css.includes('table:not(.marker-diff-table) > tbody'))
	// One pair of row colours per theme, so the rule has something to paint
	t.is((css.match(/--markserv-table-row-alt-bg:/g) || []).length, 4)
})

test('the width toggle announces the re-layout as a resize', t => {
	const html = read('markdown.html')
	const apply = html.match(/function apply\(wide\)\s*{([\s\S]*?)\n\t}/)
	t.truthy(apply)
	t.regex(apply[1], /dispatchEvent\(new Event\('resize'\)\)/)
})
