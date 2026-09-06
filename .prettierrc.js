// Options that differ from Prettier's defaults, plus the two that make the
// difference visible in a diff (semi, bracketSpacing). Matches the n8n node
// template, which is what `n8n-node lint --fix` formats against.
module.exports = {
	semi: true,
	trailingComma: 'all',
	bracketSpacing: true,
	useTabs: true,
	tabWidth: 2,
	arrowParens: 'always',
	singleQuote: true,
	quoteProps: 'as-needed',
	endOfLine: 'lf',
	printWidth: 100,
};
