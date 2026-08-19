// Pins the n8n UX guidelines the Rendobar node has to satisfy, so a later edit
// cannot quietly reintroduce a rejected pattern.
// https://docs.n8n.io/connect/create-nodes/build-your-node/reference/ux-guidelines/
const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

const { Rendobar } = require('../dist/nodes/Rendobar/Rendobar.node.js');
const { RendobarTrigger } = require('../dist/nodes/RendobarTrigger/RendobarTrigger.node.js');
const { RendobarApi } = require('../dist/credentials/RendobarApi.credentials.js');
const { SIMPLIFIED_FIELDS } = require('../dist/nodes/Rendobar/shared/output.js');

const description = new Rendobar().description;
const properties = description.properties;
const operations = properties.filter((property) => property.name === 'operation');

const ARTICLES = /\b(a|an|the)\b/i;

test('action strings omit articles', () => {
	for (const operation of operations) {
		for (const option of operation.options) {
			assert.ok(option.action, `${option.value} has no action`);
			assert.ok(!ARTICLES.test(option.action), `action "${option.action}" contains an article`);
		}
	}
});

test('action strings are sentence case', () => {
	for (const operation of operations) {
		for (const option of operation.options) {
			assert.match(option.action, /^[A-Z][a-z]/, `action "${option.action}" is not sentence case`);
		}
	}
});

test('every placeholder starts with "e.g."', () => {
	const placeholders = [];
	const walk = (list) => {
		for (const property of list) {
			// A collection's `placeholder` is the "Add Filter" button label, not an
			// example value, so it is exempt.
			if (property.placeholder && property.type !== 'collection') {
				placeholders.push(property.placeholder);
			}
			if (Array.isArray(property.options)) walk(property.options.filter((o) => o.name && o.type));
			if (Array.isArray(property.modes)) walk(property.modes);
		}
	};
	walk(properties);

	assert.ok(placeholders.length > 0);
	for (const placeholder of placeholders) {
		assert.ok(
			placeholder.startsWith('e.g. '),
			`placeholder "${placeholder}" is missing the e.g. prefix`,
		);
	}
});

test('the node exposes a Resource selector with singular option names', () => {
	const resource = properties.find((property) => property.name === 'resource');
	assert.ok(resource, 'no resource parameter');
	assert.equal(resource.noDataExpression, true);
	for (const option of resource.options) {
		assert.ok(!option.name.endsWith('s'), `resource "${option.name}" is plural`);
	}
});

test('the Job resource offers Get Many alongside Create, Get and Cancel', () => {
	const job = operations.find((operation) =>
		operation.displayOptions.show.resource.includes('job'),
	);
	const values = job.options.map((option) => option.value);
	assert.deepEqual(values.sort(), ['cancel', 'create', 'get', 'getAll']);

	const getMany = job.options.find((option) => option.value === 'getAll');
	assert.equal(getMany.name, 'Get Many');
	assert.ok(getMany.action.startsWith('Get many'));
	assert.ok(
		!/\ball\b/i.test(getMany.description),
		'Get Many description must say "many", not "all"',
	);
});

test("Get Many uses n8n's Return All and Limit copy", () => {
	const returnAll = properties.find((property) => property.name === 'returnAll');
	assert.equal(returnAll.displayName, 'Return All');
	assert.equal(returnAll.description, 'Whether to return all results or only up to a given limit');

	const limit = properties.find((property) => property.name === 'limit');
	assert.equal(limit.displayName, 'Limit');
	assert.equal(limit.default, 50);
	assert.equal(limit.description, 'Max number of results to return');
	assert.equal(limit.typeOptions.minValue, 1);
});

test('an AI-tool node offers the three-mode Output parameter', () => {
	assert.equal(description.usableAsTool, true);
	const output = properties.find((property) => property.name === 'output');
	assert.ok(output, 'no Output parameter');
	assert.equal(output.displayName, 'Output');
	assert.deepEqual(output.options.map((option) => option.value).sort(), [
		'raw',
		'selected',
		'simplified',
	]);
	// Default has to be the bounded one, or an agent still gets ~32 fields.
	assert.equal(output.default, 'simplified');
	assert.ok(SIMPLIFIED_FIELDS.length <= 10);
});

test('boolean parameter descriptions start with "Whether"', () => {
	for (const property of properties) {
		if (property.type !== 'boolean') continue;
		assert.match(
			property.description,
			/^Whether /,
			`boolean "${property.displayName}" description must start with Whether`,
		);
	}
});

test('the node, trigger and credential all ship distinct light and dark icons', () => {
	const cases = [
		['node', description.icon, 'dist/nodes/Rendobar'],
		['trigger', new RendobarTrigger().description.icon, 'dist/nodes/RendobarTrigger'],
		['credential', new RendobarApi().icon, 'dist/credentials'],
	];

	for (const [label, icon, base] of cases) {
		assert.equal(typeof icon, 'object', `${label} icon is not a light/dark pair`);
		assert.ok(icon.light.startsWith('file:'), `${label} light icon missing file: protocol`);
		assert.ok(icon.dark.startsWith('file:'), `${label} dark icon missing file: protocol`);
		assert.notEqual(icon.light, icon.dark, `${label} light and dark icons are the same file`);

		const root = resolve(__dirname, '..');
		for (const path of [icon.light, icon.dark]) {
			const resolved = resolve(root, base, path.replace(/^file:/, ''));
			assert.ok(existsSync(resolved), `${label} icon ${resolved} does not exist in the build`);
		}
	}
});

test('the built package still carries both nodes and the credential', () => {
	assert.equal(description.name, 'rendobar');
	assert.equal(new RendobarTrigger().description.name, 'rendobarTrigger');
	assert.equal(new RendobarApi().name, 'rendobarApi');
	assert.ok(dirname(require.resolve('../dist/nodes/Rendobar/Rendobar.node.js')));
});
