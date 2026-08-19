// Three of the nine job types Rendobar serves today — compose, image.generate
// and image.edit — describe their parameters as a choice between shapes, and
// the flat field list `GET /jobs/types/:type/schema` projects comes back empty
// for them. Without the JSON editor the form submits {} and the API refuses the
// job, with nothing in the panel to fill in. These pin the two halves of the
// way out: telling that case apart from a job type that genuinely takes no
// parameters, and offering the editor that can express it.
const test = require('node:test');
const assert = require('node:assert/strict');

const { describesParameters } = require('../dist/nodes/Rendobar/methods/getJobFields.js');
const { Rendobar } = require('../dist/nodes/Rendobar/Rendobar.node.js');

const properties = new Rendobar().description.properties;
const byName = (name) => properties.find((property) => property.name === name);

// Trimmed from the live response for https://api.rendobar.com/jobs/types/compose/schema.
const composeSchema = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	anyOf: [{ $ref: '#/$defs/timeline' }, { $ref: '#/$defs/prompt' }],
	$defs: {},
};

// And from .../ffprobe/schema, which projects two fields and needs no JSON.
const ffprobeSchema = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: { streams: { type: 'boolean' }, format: { type: 'boolean' } },
	required: [],
};

test('a union schema counts as describing parameters', () => {
	assert.equal(describesParameters(composeSchema), true);
	assert.equal(describesParameters({ oneOf: [{}, {}] }), true);
	assert.equal(describesParameters({ allOf: [{}] }), true);
});

test('an ordinary object schema counts too', () => {
	assert.equal(describesParameters(ffprobeSchema), true);
});

test('a schema with nothing in it does not', () => {
	// This is the job type that really takes no parameters, and the notice for it
	// has to say so rather than send the user to the JSON editor.
	assert.equal(describesParameters({ type: 'object', properties: {} }), false);
	assert.equal(describesParameters({ anyOf: [] }), false);
	assert.equal(describesParameters({}), false);
});

test('a missing or malformed schema does not', () => {
	for (const junk of [undefined, null, 'text', 42, [{ anyOf: [1] }]]) {
		assert.equal(describesParameters(junk), false, `${JSON.stringify(junk)} should not qualify`);
	}
});

test('Create offers both a form and a JSON editor for the parameters', () => {
	const mode = byName('paramsMode');
	assert.ok(mode, 'no Specify Parameters parameter');
	assert.equal(mode.type, 'options');
	assert.deepEqual(
		mode.options.map((option) => option.value),
		['fields', 'json'],
	);
	// A workflow saved before this parameter existed stores nothing for it, so
	// the default has to be the behaviour those workflows already had.
	assert.equal(mode.default, 'fields');
});

test('exactly one parameter editor is on show at a time', () => {
	const form = byName('params');
	const json = byName('paramsJson');

	assert.deepEqual(form.displayOptions.show.paramsMode, ['fields']);
	assert.deepEqual(json.displayOptions.show.paramsMode, ['json']);
	assert.equal(json.type, 'json');
	assert.equal(json.default, '{}');

	for (const editor of [form, json]) {
		assert.deepEqual(editor.displayOptions.show.operation, ['create']);
		assert.deepEqual(editor.displayOptions.show.resource, ['job']);
	}
});

test('the JSON editor names the job types that need it', () => {
	// A user staring at an empty Parameters panel has to be able to work out
	// which control fixes it, so the description names the three.
	const json = byName('paramsJson');
	for (const jobType of ['Compose', 'Image Generate', 'Image Edit']) {
		assert.ok(json.description.includes(jobType), `${jobType} is not mentioned`);
	}
});

test('the parameter editors sit between Job Type and the waiting controls', () => {
	const order = properties.map((property) => property.name);
	assert.ok(order.indexOf('paramsMode') > order.indexOf('jobType'));
	assert.ok(order.indexOf('params') > order.indexOf('paramsMode'));
	assert.ok(order.indexOf('paramsJson') > order.indexOf('params'));
	assert.ok(order.indexOf('waitForCompletion') > order.indexOf('paramsJson'));
});
