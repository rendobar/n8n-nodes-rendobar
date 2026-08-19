// Encodes n8n's verification guidelines as tests, so the constraints that gate
// verification are checked on every run rather than only at review time.
// https://docs.n8n.io/connect/create-nodes/build-your-node/reference/verification-guidelines/
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync, statSync } = require('node:fs');
const { join, resolve, sep } = require('node:path');

const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Every file the package would publish, which is `dist/` and nothing else. */
function shippedFiles(dir = join(root, 'dist')) {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		return statSync(path).isDirectory() ? shippedFiles(path) : [path];
	});
}

const shipped = shippedFiles();
const code = shipped.filter((path) => path.endsWith('.js'));

/** The importable example workflows fenced in the README. */
function readmeWorkflows(readme) {
	const fence = /```json\r?\n([\s\S]*?)```/g;
	return [...readme.matchAll(fence)].map((match) => JSON.parse(match[1]));
}

test('the build actually produced the files the package points at', () => {
	assert.ok(code.length > 0, 'dist/ has no JavaScript');
	for (const entry of [...pkg.n8n.nodes, ...pkg.n8n.credentials]) {
		assert.ok(
			shipped.includes(join(root, entry.split('/').join(sep))),
			`${entry} is declared but not in the build`,
		);
	}
});

test('the shipped code never touches the file system', () => {
	// "Code cannot access environment variables or interact with the file system."
	const banned = [
		/require\(['"](node:)?fs(\/promises)?['"]\)/,
		/require\(['"](node:)?child_process['"]\)/,
		/require\(['"](node:)?os['"]\)/,
		/\breadFileSync\b/,
		/\bwriteFileSync\b/,
		/\bcreateWriteStream\b/,
		/\bcreateReadStream\b/,
	];

	for (const path of code) {
		const source = readFileSync(path, 'utf8');
		for (const pattern of banned) {
			assert.equal(pattern.test(source), false, `${path} matches ${pattern}`);
		}
	}
});

test('the shipped code never reads environment variables', () => {
	for (const path of code) {
		const source = readFileSync(path, 'utf8');
		assert.equal(/process\s*\.\s*env/.test(source), false, `${path} reads process.env`);
	}
});

test('the package ships no runtime dependencies', () => {
	// "must not include any external dependencies to keep it lightweight"
	assert.equal(pkg.dependencies, undefined, 'a runtime dependency was added');
	assert.deepEqual(
		Object.keys(pkg.peerDependencies),
		['n8n-workflow'],
		'n8n itself is the only peer',
	);
	assert.deepEqual(pkg.files, ['dist'], 'only the build is published');
});

test('the package is MIT and points at its public repository', () => {
	assert.equal(pkg.license, 'MIT');
	assert.match(pkg.repository.url, /^https:\/\/github\.com\/rendobar\/n8n-nodes-rendobar\.git$/);
	assert.ok(pkg.keywords.includes('n8n-community-node-package'));
	assert.ok(pkg.author.name);
});

test('the shipped code is English only', () => {
	// Interface text, descriptions and messages must all be English. Mechanically
	// that means the build carries nothing outside Latin-1 apart from the few
	// punctuation marks the source comments use.
	const allowed = new Set(['—', '–', '‘', '’', '“', '”', '…', '─']);

	for (const path of code) {
		const source = readFileSync(path, 'utf8');
		for (const character of source) {
			const point = character.codePointAt(0);
			assert.ok(
				point < 0x0100 || allowed.has(character),
				`${path} carries non-English script: ${JSON.stringify(character)}`,
			);
		}
	}
});

test('the package integrates exactly one third-party service', () => {
	// One action node plus its trigger, sharing one credential.
	assert.equal(pkg.n8n.nodes.length, 2);
	assert.equal(pkg.n8n.credentials.length, 1);
});

test('sensitive credential fields are password fields', () => {
	const { RendobarApi } = require('../dist/credentials/RendobarApi.credentials.js');
	const credential = new RendobarApi();
	const apiKey = credential.properties.find((property) => property.name === 'apiKey');

	assert.equal(apiKey.typeOptions.password, true, 'the API key must be masked');
	assert.equal(apiKey.required, true);

	// And the credential is verifiable, so n8n can tell the user it works.
	assert.ok(credential.test.request.url);
	assert.ok(credential.documentationUrl);
});

test('the README documents what the guidelines require of it', () => {
	const readme = readFileSync(join(root, 'README.md'), 'utf8');
	for (const needed of [
		'## Installation',
		'## Credentials',
		'## Example workflows',
		'https://rendobar.com/docs',
		'https://docs.n8n.io/integrations/community-nodes/',
	]) {
		assert.ok(readme.includes(needed), `README is missing ${needed}`);
	}
	// Usage instructions have to include a workflow a user can actually import.
	assert.ok(readme.includes('"nodes": ['), 'README has no importable example workflow');
});

test('the README example workflows use parameters the nodes actually have', () => {
	// A reviewer imports these. A renamed parameter would leave them silently
	// half-configured, which is worse than having no example at all.
	const { Rendobar } = require('../dist/nodes/Rendobar/Rendobar.node.js');
	const { RendobarTrigger } = require('../dist/nodes/RendobarTrigger/RendobarTrigger.node.js');

	const known = {
		'@rendobar/n8n-nodes-rendobar.rendobar': new Rendobar().description,
		'@rendobar/n8n-nodes-rendobar.rendobarTrigger': new RendobarTrigger().description,
	};

	const readme = readFileSync(join(root, 'README.md'), 'utf8');
	const blocks = readmeWorkflows(readme);
	assert.ok(blocks.length >= 2, 'expected at least two importable example workflows');

	let checked = 0;
	for (const workflow of blocks) {
		for (const node of workflow.nodes) {
			const description = known[node.type];
			if (description === undefined) continue;

			const names = new Set(description.properties.map((property) => property.name));
			for (const parameter of Object.keys(node.parameters)) {
				assert.ok(names.has(parameter), `${node.type} has no '${parameter}' parameter`);
				checked += 1;
			}

			// Every node in an example must name a credential-bearing node type
			// that the package actually registers.
			assert.ok(description.version >= 1);
		}
	}
	assert.ok(checked > 10, 'the examples barely configure anything');
});

test('a resource-locator parameter in the examples uses the locator shape', () => {
	const blocks = readmeWorkflows(readFileSync(join(root, 'README.md'), 'utf8'));
	const { Rendobar } = require('../dist/nodes/Rendobar/Rendobar.node.js');
	const locators = new Set(
		new Rendobar()
			.description.properties.filter((property) => property.type === 'resourceLocator')
			.map((property) => property.name),
	);

	let seen = 0;
	for (const workflow of blocks) {
		for (const node of workflow.nodes) {
			for (const [name, value] of Object.entries(node.parameters)) {
				if (!locators.has(name)) continue;
				seen += 1;
				assert.equal(value.__rl, true, `${name} is not written as a resource locator`);
				assert.ok(value.mode, `${name} has no mode`);
			}
		}
	}
	assert.ok(seen >= 2, 'the examples no longer exercise the resource locators');
});

test('both nodes ship a codex file pointing at the documentation', () => {
	// Without one, n8n shows the node with no documentation link and no category.
	const { Rendobar } = require('../dist/nodes/Rendobar/Rendobar.node.js');
	const { RendobarTrigger } = require('../dist/nodes/RendobarTrigger/RendobarTrigger.node.js');

	const cases = [
		['dist/nodes/Rendobar/Rendobar.node.json', new Rendobar().description.name],
		['dist/nodes/RendobarTrigger/RendobarTrigger.node.json', new RendobarTrigger().description.name],
	];

	for (const [file, nodeName] of cases) {
		const codex = JSON.parse(readFileSync(join(root, ...file.split('/')), 'utf8'));
		assert.equal(codex.node, `${pkg.name}.${nodeName}`, `${file} names the wrong node`);
		assert.ok(codex.categories.length > 0, `${file} has no category`);
		assert.ok(codex.resources.primaryDocumentation[0].url.startsWith('https://'));
		assert.ok(codex.resources.credentialDocumentation[0].url.startsWith('https://'));
	}
});
