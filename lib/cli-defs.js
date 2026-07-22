module.exports = {
	flags: {
		port: {
			alias: 'p',
			default: '7642'
		},

		hotreload: {
			alias: 'l',
			type: 'boolean',
			default: true
		},

		address: {
			alias: 'a',
			default: 'localhost'
		},

		silent: {
			alias: 's',
			type: 'boolean',
			default: false
		},

		verbose: {
			alias: 'v',
			type: 'boolean',
			default: false
		},

		theme: {
			default: 'dark'
		},

		light: {
			type: 'boolean',
			default: false
		},

		synthwave: {
			type: 'boolean',
			default: false
		},

		browser: {
			alias: 'b',
			type: 'boolean',
			default: true
		},

		json: {
			type: 'boolean',
			default: false
		}
	}
}
