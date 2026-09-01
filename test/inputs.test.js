// The media half of the job form.
//
// Until the API published an inputs descriptor, the only way to tell the node
// what a job should read was to hand-write {"source": "https://..."} into a
// JSON box, which meant knowing the key name before anything would run. These
// pin the field form built from that descriptor, and the three fallbacks that
// have to keep working: a deployment too old to publish one, a job type that
// names its files in the command, and a job type that reads nothing.
const test = require('node:test');
const assert = require('node:assert/strict');

const { inputFieldsFrom } = require('../dist/nodes/Rendobar/methods/getJobInputFields.js');
const { Rendobar } = require('../dist/nodes/Rendobar/Rendobar.node.js');

const properties = new Rendobar().description.properties;
const byName = (name) => properties.find((property) => property.name === name);

const load = (inputs, jobType = 'compress.target') => inputFieldsFrom(inputs, jobType);

test('a named input becomes a required string field', () => {
	const result = load({
		variadic: false,
		fields: [
			{ key: 'source', name: 'source', label: 'Source', type: 'string', required: true, url: true, description: 'URL to the source video' },
		],
	});
	assert.equal(result.fields.length, 1);
	assert.equal(result.fields[0].id, 'source');
	assert.equal(result.fields[0].displayName, 'Source');
	assert.equal(result.fields[0].required, true);
	assert.equal(result.fields[0].type, 'string');
});

test('an optional input stays optional', () => {
	const result = load({
		variadic: false,
		fields: [
			{ key: 'source', name: 'source', label: 'Source', type: 'string', required: true, url: true },
			{ key: 'subtitles', name: 'subtitles', label: 'Subtitles', type: 'string', required: false, url: true },
		],
	});
	const subtitles = result.fields.find((field) => field.id === 'subtitles');
	// Requiring it would be a lie the panel renders faithfully: omitting it is
	// what selects auto-extraction.
	assert.equal(subtitles.required, false);
});

test('an input that takes several files maps as an array', () => {
	const result = load({
		variadic: false,
		fields: [{ key: 'images', name: 'images', label: 'Images', type: 'json', required: true, url: true, multiple: true }],
	});
	assert.equal(result.fields[0].type, 'array');
});

test('a job type that names its files in the command sends the user to JSON', () => {
	const result = load({ variadic: true, fields: [] }, 'ffmpeg');
	assert.deepEqual(result.fields, []);
	assert.match(result.emptyFieldsNotice, /Using JSON/);
	assert.match(result.emptyFieldsNotice, /filename/);
});

test('an API with no inputs descriptor says so instead of showing an empty form', () => {
	const result = load(undefined);
	assert.deepEqual(result.fields, []);
	assert.match(result.emptyFieldsNotice, /does not describe job inputs/);
	assert.match(result.emptyFieldsNotice, /Using JSON/);
});

test('a job type that reads nothing says that too', () => {
	const result = load({ variadic: false, fields: [] });
	assert.deepEqual(result.fields, []);
	assert.match(result.emptyFieldsNotice, /reads no input files/);
});

test('the node offers both ways to give a job its media', () => {
	const mode = byName('inputsMode');
	assert.ok(mode, 'inputsMode property missing');
	assert.deepEqual(mode.options.map((option) => option.value), ['fields', 'json']);

	const mapper = byName('inputFields');
	assert.equal(mapper.type, 'resourceMapper');
	assert.equal(mapper.typeOptions.resourceMapper.resourceMapperMethod, 'getJobInputFields');
	// It has to reload when the job type changes, or it keeps the previous
	// type's inputs and silently submits the wrong keys.
	assert.deepEqual(mapper.typeOptions.loadOptionsDependsOn, ['jobType.value']);
	assert.deepEqual(mapper.displayOptions.show.inputsMode, ['fields']);

	// The JSON editor stays, and is the only thing shown in the other mode.
	assert.deepEqual(byName('inputs').displayOptions.show.inputsMode, ['json']);
});
