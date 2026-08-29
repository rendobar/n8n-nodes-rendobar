// The ResourceMapper keys rows by a field's `key`, which is unique. The request
// has to be built from `name`, which is not. This is the translation between
// them, and getting it wrong submits `params.steps__14u9vwk` instead of
// `params.steps`, which the API rejects.
const test = require('node:test');
const assert = require('node:assert/strict');

const { paramNamesFromKeys } = require('../dist/nodes/Rendobar/Rendobar.node.js');

test('leaves an ordinary key alone', () => {
	assert.deepEqual(paramNamesFromKeys({ prompt: 'a cat', width: 512 }), {
		prompt: 'a cat',
		width: 512,
	});
});

test('strips the variant digest to recover the param name', () => {
	// image.generate emits four `steps` fields, one per model, each with its own
	// bounds. Only the selected model's row is ever filled in.
	assert.deepEqual(paramNamesFromKeys({ steps__14u9vwk: 8 }), { steps: 8 });
});

test('keeps a name that merely contains a digit-like tail', () => {
	// A single underscore is not the variant separator, so this is a real name.
	assert.deepEqual(paramNamesFromKeys({ my_field: 1 }), { my_field: 1 });
});

test('leaves a null alone for providedParams to drop', () => {
	// Translation and null-stripping are separate steps on purpose.
	assert.deepEqual(paramNamesFromKeys({ steps__abc123: null }), { steps: null });
});
