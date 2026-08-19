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
const {
	SIMPLIFIED_FIELD_LIMIT,
	buildJobJson,
} = require('../dist/nodes/Rendobar/shared/output.js');

const description = new Rendobar().description;
const properties = description.properties;
const operations = properties.filter((property) => property.name === 'operation');

const ARTICLES = /\b(a|an|the)\b/i;

/** Every property in the tree, including those nested in a collection. */
function allProperties(list) {
	const found = [];
	for (const property of list) {
		found.push(property);
		if (Array.isArray(property.options)) {
			// A collection's options are properties; a dropdown's options are values.
			found.push(...allProperties(property.options.filter((option) => option.type !== undefined)));
			// A fixedCollection's options are named groups whose `values` are the
			// real properties, so the same rules have to reach into them.
			for (const option of property.options) {
				if (Array.isArray(option.values)) found.push(...allProperties(option.values));
			}
		}
		if (Array.isArray(property.modes)) found.push(...property.modes);
	}
	return found;
}

const everyProperty = allProperties(properties);

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

test('an operation description adds context instead of restating the name', () => {
	for (const operation of operations) {
		for (const option of operation.options) {
			assert.ok(option.description, `${option.value} has no description`);
			assert.match(
				option.description,
				/^[A-Z][a-z]/,
				`description "${option.description}" is not sentence case`,
			);
			assert.ok(
				option.description.split(/\s+/).length >= 5,
				`description "${option.description}" is too thin to add context`,
			);
			assert.notEqual(
				option.description.toLowerCase().replace(/[^a-z ]/g, '').trim(),
				option.name.toLowerCase(),
				`description for ${option.value} only restates the name`,
			);
		}
	}
});

test('every placeholder starts with "e.g."', () => {
	const placeholders = everyProperty
		// A collection's `placeholder` is its "Add …" button label, not an example
		// value, so it is exempt. The same is true of a fixedCollection, which is
		// how n8n's own HTTP Request node labels its header rows ("Add Parameter").
		.filter(
			(property) =>
				property.placeholder &&
				property.type !== 'collection' &&
				property.type !== 'fixedCollection',
		)
		.map((property) => property.placeholder);

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

test('Get Many offers sorting in its own collection below Filters', () => {
	// The guidelines point at Airtable Record:Search: sorting goes in a dedicated
	// collection placed below the options collection, not mixed into it.
	const order = properties.map((property) => property.name);
	assert.ok(order.indexOf('sort') > order.indexOf('filters'), 'Sort must sit below Filters');

	const sort = properties.find((property) => property.name === 'sort');
	assert.equal(sort.type, 'collection');
	assert.equal(sort.displayName, 'Sort');
	assert.deepEqual(
		sort.options.map((option) => option.name).sort(),
		['order', 'sortBy'],
	);
});

test('a single item is chosen through a Resource Locator defaulting to the list', () => {
	// Both Job Type and Job pick exactly one thing, which is what the guidelines
	// say a Resource Locator is for, and the default mode has to be From List.
	const locators = properties.filter((property) => property.type === 'resourceLocator');
	assert.deepEqual(
		locators.map((property) => property.name).sort(),
		['jobId', 'jobType'],
	);

	for (const locator of locators) {
		assert.equal(locator.default.mode, 'list', `${locator.name} does not default to the list`);
		const modes = locator.modes.map((mode) => mode.name);
		assert.equal(modes[0], 'list', `${locator.name} does not show From List first`);
		assert.equal(
			locator.modes[0].typeOptions.searchable,
			true,
			`${locator.name} list is not searchable`,
		);
	}
});

test('the Job locator can also take an ID or a dashboard link', () => {
	const job = properties.find((property) => property.name === 'jobId');
	const byUrl = job.modes.find((mode) => mode.name === 'url');
	assert.ok(byUrl, 'no By URL mode');
	assert.equal(byUrl.extractValue.type, 'regex');

	// The extractor has to lift the ID out of a pasted dashboard link.
	const extracted = new RegExp(byUrl.extractValue.regex).exec(
		'https://app.rendobar.com/jobs/job_abc123',
	);
	assert.equal(extracted[1], 'job_abc123');

	for (const mode of job.modes.filter((entry) => entry.type === 'string')) {
		assert.ok(mode.validation?.length, `${mode.name} has no validation`);
		for (const rule of mode.validation) {
			assert.ok(rule.properties.errorMessage, `${mode.name} validation has no guidance`);
		}
	}
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
	// Default has to be the bounded one, or an agent still gets ~33 fields.
	assert.equal(output.default, 'simplified');
	assert.ok(
		Object.keys(buildJobJson({ id: 'j', type: 't', status: 'complete', output: { data: 1, file: null, files: [], expiresAt: null }, cost: 1, createdAt: 1, completedAt: 2 }, 'simplified')).length <=
			SIMPLIFIED_FIELD_LIMIT,
	);
});

test('both resources get the three-mode Output parameter', () => {
	// The guideline applies per endpoint: an asset carries 21 fields, so the File
	// resource needs the same treatment the Job resource gets.
	const outputs = properties.filter((property) => property.displayName === 'Output');
	assert.equal(outputs.length, 2, 'expected an Output parameter for each resource');

	const resources = outputs.flatMap((output) => output.displayOptions.show.resource);
	assert.deepEqual(resources.sort(), ['file', 'job']);

	for (const output of outputs) {
		assert.equal(output.default, 'simplified');
		assert.deepEqual(output.options.map((option) => option.value).sort(), [
			'raw',
			'selected',
			'simplified',
		]);
	}
});

test('each Output has a Fields list shown only in Selected Fields mode', () => {
	const lists = properties.filter((property) => property.displayName === 'Fields');
	assert.equal(lists.length, 2);

	for (const list of lists) {
		assert.equal(list.type, 'multiOptions');
		const shown = list.displayOptions.show;
		const modes = shown.output ?? shown.assetOutput;
		assert.deepEqual(modes, ['selected'], `${list.name} is not gated on Selected Fields`);
		assert.match(list.description, /ID is always included/);
	}
});

test('Selected Fields lists every job field with a title-cased label', () => {
	const fields = properties.find((property) => property.name === 'outputFields');
	assert.equal(fields.type, 'multiOptions');
	assert.ok(fields.options.length > 30, 'the field list looks truncated');

	for (const option of fields.options) {
		// n8n's style guide spells these two out; "Id" and "Url" are rejected.
		assert.ok(!/\bId\b/.test(option.name), `${option.name} should spell ID in capitals`);
		assert.ok(!/\bUrl\b/.test(option.name), `${option.name} should spell URL in capitals`);
		assert.match(option.name, /^[A-Z]/, `${option.name} is not title case`);
	}

	const names = fields.options.map((option) => option.name);
	assert.ok(names.includes('ID'));
	assert.ok(names.includes('Web URL'));
	assert.ok(names.includes('Org ID'));
});

test('boolean parameter descriptions start with "Whether"', () => {
	const booleans = everyProperty.filter((property) => property.type === 'boolean');
	assert.ok(booleans.length >= 3, 'expected the node to still have boolean parameters');

	for (const property of booleans) {
		assert.match(
			property.description,
			/^Whether /,
			`boolean "${property.displayName}" description must start with Whether`,
		);
	}
});

test('display names are title case and descriptions are sentence case', () => {
	for (const property of everyProperty) {
		if (property.displayName) {
			assert.match(
				property.displayName,
				/^[A-Z(]/,
				`display name "${property.displayName}" is not title case`,
			);
			assert.ok(
				!/\bId\b/.test(property.displayName) && !/\bUrl\b/.test(property.displayName),
				`display name "${property.displayName}" should spell ID/URL in capitals`,
			);
		}
		for (const copy of [property.description, property.hint]) {
			if (typeof copy === 'string' && copy.length > 0) {
				assert.match(copy, /^[A-Z]/, `"${copy}" should read as a sentence`);
			}
		}
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

test('the list methods the UI names are the ones the node registers', () => {
	const node = new Rendobar();
	const registered = Object.keys(node.methods.listSearch);
	const referenced = properties
		.filter((property) => property.type === 'resourceLocator')
		.flatMap((property) => property.modes)
		.map((mode) => mode.typeOptions?.searchListMethod)
		.filter(Boolean);

	assert.ok(referenced.length > 0);
	for (const method of referenced) {
		assert.ok(registered.includes(method), `${method} is referenced but not registered`);
	}
	assert.ok(Object.keys(node.methods.resourceMapping).includes('getJobFields'));
});

test('the asset field list spells its acronyms the way n8n does', () => {
	const fields = properties.find((property) => property.name === 'assetOutputFields');
	const names = fields.options.map((option) => option.name);
	assert.ok(names.includes('URL'), 'url must render as URL, not Url');
	assert.ok(names.includes('ETag'));
	assert.ok(names.includes('ID'));
	for (const name of names) {
		assert.ok(!/Url/.test(name) && !/Id/.test(name), `${name} is miscased`);
	}
});

test('every dropdown default is one of the values it offers', () => {
	// A default outside the option list renders as an empty field the user has to
	// notice and fix.
	for (const property of everyProperty) {
		if (property.type !== 'options' && property.type !== 'multiOptions') continue;
		const offered = new Set(property.options.map((option) => option.value));
		const defaults = Array.isArray(property.default) ? property.default : [property.default];

		for (const value of defaults) {
			assert.ok(
				offered.has(value),
				`${property.displayName} defaults to "${value}", which it does not offer`,
			);
		}
	}
});

test('every dropdown lists its options alphabetically', () => {
	// n8n's UI guidance: sort lists alphabetically so a value is findable.
	const exempt = new Set(['output', 'assetOutput', 'sortBy', 'order']);

	for (const property of everyProperty) {
		if (property.type !== 'options' && property.type !== 'multiOptions') continue;
		if (exempt.has(property.name)) continue;

		const names = property.options.map((option) => option.name);
		assert.deepEqual(
			names,
			[...names].sort((left, right) => left.localeCompare(right)),
			`${property.displayName} is not sorted`,
		);
	}
});

test('every displayOptions rule names a parameter that exists', () => {
	// A typo here does not fail the build; it just makes the field never appear.
	const names = new Set(properties.map((property) => property.name));

	for (const property of properties) {
		for (const rule of ['show', 'hide']) {
			for (const referenced of Object.keys(property.displayOptions?.[rule] ?? {})) {
				assert.ok(
					names.has(referenced),
					`${property.displayName} is gated on '${referenced}', which is not a parameter`,
				);
			}
		}
	}
});

test('every gated parameter is reachable from some resource and operation', () => {
	// Walks each resource/operation pair and checks the whole property tree is
	// visible somewhere, so nothing ships permanently hidden.
	const resource = properties.find((property) => property.name === 'resource');
	const reachable = new Set();

	for (const { value: resourceValue } of resource.options) {
		const operationsFor = operations.filter((operation) =>
			operation.displayOptions.show.resource.includes(resourceValue),
		);

		for (const operation of operationsFor) {
			for (const { value: operationValue } of operation.options) {
				for (const property of properties) {
					const show = property.displayOptions?.show;
					if (show === undefined) {
						reachable.add(property.name);
						continue;
					}
					if (show.resource && !show.resource.includes(resourceValue)) continue;
					if (show.operation && !show.operation.includes(operationValue)) continue;
					reachable.add(property.name);
				}
			}
		}
	}

	for (const property of properties) {
		assert.ok(reachable.has(property.name), `${property.name} can never be shown`);
	}
});
