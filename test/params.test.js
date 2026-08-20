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
// The Create options moved into an 'Options' collection in 0.5.0, so a lookup
// by name has to descend into it. Kept as one helper rather than repeated
// inline so a future move updates one place.
const collectionChildren = (name) => {
	const collection = properties.find((property) => property.type === 'collection' && property.name === name);
	return collection ? collection.options : [];
};
const createOption = (name) => collectionChildren('options').find((option) => option.name === name);


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

test('the parameter editors sit between Job Type and Options', () => {
	// The Create panel is four things and a disclosure now: what to run, what it
	// reads, how the settings are given, and the settings themselves. Everything
	// optional sits behind Options, which is the last thing in the panel.
	const order = properties.map((property) => property.name);
	assert.ok(order.indexOf('paramsMode') > order.indexOf('jobType'));
	assert.ok(order.indexOf('params') > order.indexOf('paramsMode'));
	assert.ok(order.indexOf('paramsJson') > order.indexOf('params'));
	assert.ok(
		order.indexOf('options') > order.indexOf('paramsJson'),
		'Options has to come after the editors it is optional relative to',
	);
});

// ── Parameters nobody filled in ───────────────────────────────────────────
//
// n8n draws a number field with element-plus's InputNumber, which turns the
// empty input into 0 as it mounts and writes that back into the mapped value.
// Opening the panel was enough to do it: `ffprobe` came back "Invalid job
// parameters: Too small: expected number to be >0" for a Timeout nobody had
// touched, and a fresh `image.upscale` node arrived carrying seed 0, which the
// API accepts and which quietly pins a generation meant to stay random.
//
// Nothing n8n saves separates that 0 from one the user typed — the schema entry
// beside it is identical either way — so these pin the only fix that can hold:
// a field n8n would fill in by itself is offered rather than drawn, and
// whatever the form does hold is sent exactly as it stands.

const { toMapperField } = require('../dist/nodes/Rendobar/methods/getJobFields.js');
const { providedParams } = require('../dist/nodes/Rendobar/Rendobar.node.js');

// Straight from https://api.rendobar.com/jobs/types/ffprobe/schema.
const ffprobeFields = [
	{ name: 'command', label: 'Command', type: 'string', required: true, minLength: 1 },
	{ name: 'timeout', label: 'Timeout', type: 'number', required: false, max: 9007199254740991 },
];

// And from .../image.upscale/schema, where 0 is a value the user may well mean.
const upscaleFields = [
	{ name: 'inputNoise', label: 'Input noise', type: 'number', required: false, default: 0.1 },
	{ name: 'seed', label: 'Seed', type: 'number', required: false, min: 0 },
	{ name: 'passes', label: 'Passes', type: 'number', required: false, min: 1 },
	{ name: 'colorCorrection', label: 'Color correction', type: 'options', required: false },
];

test('an optional number the job type gives no default for starts unmapped', () => {
	const timeout = toMapperField(ffprobeFields[1]);
	assert.equal(timeout.type, 'number');
	// `removed` is what keeps the input from being drawn, and an input that is
	// never drawn can never mount and invent its 0.
	assert.equal(timeout.removed, true);
});

test('a number the job type does give a default for stays on the form', () => {
	// n8n pre-fills this one with 0.1, so its input never mounts empty and there
	// is nothing to invent. Hiding it would cost the user the default for nothing.
	const inputNoise = toMapperField(upscaleFields[0]);
	assert.equal(inputNoise.defaultValue, 0.1);
	assert.equal(inputNoise.removed, undefined);
});

test('only numbers start unmapped', () => {
	// Every other kind of input renders empty and stays empty. `command` is also
	// required, and a required field must never be hidden — n8n gives no way to
	// bring it back.
	assert.equal(toMapperField(ffprobeFields[0]).removed, undefined);
	assert.equal(toMapperField(upscaleFields[3]).removed, undefined);
	assert.equal(
		toMapperField({ name: 'n', type: 'number', required: true }).removed,
		undefined,
		'a required number has to stay on the form',
	);
});

test('every optional no-default number of image.upscale starts unmapped', () => {
	// seed and passes are the two that made this urgent: 0 is a legal seed, so
	// the API cannot reject it and the wrong image comes back instead.
	for (const field of [upscaleFields[1], upscaleFields[2]]) {
		assert.equal(toMapperField(field).removed, true, `${field.name} should start unmapped`);
	}
});

test('a field the user filled in is sent exactly as it stands', () => {
	// The deliberate 0 this whole change exists to protect.
	assert.deepEqual(providedParams({ seed: 0, passes: 2 }), { seed: 0, passes: 2 });
	assert.deepEqual(providedParams({ outlineWidth: 0, boxOpacity: 0 }), {
		outlineWidth: 0,
		boxOpacity: 0,
	});
	// And every other value that could be mistaken for absent.
	assert.deepEqual(providedParams({ a: '', b: false, c: [], d: {} }), {
		a: '',
		b: false,
		c: [],
		d: {},
	});
});

test('a field n8n marks unfilled is not sent at all', () => {
	// n8n writes null for an empty mapped field. Its editor prunes those before
	// saving; a workflow built through the REST API keeps them, and the API
	// refuses a null where it wants a number.
	assert.deepEqual(providedParams({ command: 'in.mp4', timeout: null }), { command: 'in.mp4' });
	assert.deepEqual(providedParams({}), {});
	assert.deepEqual(providedParams({ timeout: null }), {});
});
