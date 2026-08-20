// Six Create parameters moved into an 'Options' collection in 0.5.0. Moving a
// parameter into a collection changes WHERE n8n stores it, so a workflow saved
// on 0.3.0 or 0.4.0 keeps its value at the top level while anything built on
// 0.5.0 stores it under `options`.
//
// Both have to keep working, and the failure mode if they do not is quiet: the
// node reads the default instead of the saved value, so a workflow that waited
// 600 seconds silently starts waiting 300, and one that posted a callback
// silently stops posting. Nothing errors. The plan for this work asked for a
// test that loads a 0.3.0-shaped parameter object for exactly that reason, and
// because the getAll and idempotency regressions both came from assuming a
// shape.
const test = require('node:test');
const assert = require('node:assert/strict');

const { readCreateOption } = require('../dist/nodes/Rendobar/Rendobar.node.js');

/**
 * Stands in for n8n's parameter resolution: a saved workflow is a flat bag of
 * values, and `getNodeParameter` returns whatever is under the name, falling
 * back to the caller's default when the key is absent. That is true whether or
 * not the parameter is still declared in the node description, which is what
 * makes reading the old location work after the declaration has gone.
 */
const contextFor = (saved) => ({
	getNodeParameter(name, _itemIndex, fallback) {
		return name in saved ? saved[name] : fallback;
	},
});

test('a 0.3.0 workflow keeps its top-level values after the move', () => {
	const saved = {
		waitForCompletion: true,
		pollInterval: 10,
		maxWait: 600,
		callbackUrl: 'https://example.com/resume',
		idempotencyKey: 'order-4417',
	};
	const context = contextFor(saved);

	assert.equal(readCreateOption(context, 'waitForCompletion', 0, false), true);
	assert.equal(readCreateOption(context, 'pollInterval', 0, 5), 10);
	assert.equal(readCreateOption(context, 'maxWait', 0, 300), 600);
	assert.equal(readCreateOption(context, 'callbackUrl', 0, ''), 'https://example.com/resume');
	assert.equal(readCreateOption(context, 'idempotencyKey', 0, ''), 'order-4417');
});

test('a 0.5.0 workflow reads the same values out of Options', () => {
	const context = contextFor({
		options: { waitForCompletion: true, maxWait: 600, callbackUrl: 'https://example.com/resume' },
	});

	assert.equal(readCreateOption(context, 'waitForCompletion', 0, false), true);
	assert.equal(readCreateOption(context, 'maxWait', 0, 300), 600);
	assert.equal(readCreateOption(context, 'callbackUrl', 0, ''), 'https://example.com/resume');
});

test('Options wins when a workflow carries both, so a migration is not ambiguous', () => {
	const context = contextFor({ maxWait: 600, options: { maxWait: 900 } });

	assert.equal(readCreateOption(context, 'maxWait', 0, 300), 900);
});

test('a half-migrated workflow reads each parameter from wherever it actually is', () => {
	// The realistic shape after someone opens an old workflow and edits one
	// thing: the parameter they touched moves into Options, the rest do not.
	const context = contextFor({
		maxWait: 600,
		callbackUrl: 'https://example.com/resume',
		options: { waitForCompletion: true },
	});

	assert.equal(readCreateOption(context, 'waitForCompletion', 0, false), true, 'from Options');
	assert.equal(readCreateOption(context, 'maxWait', 0, 300), 600, 'still at the top level');
	assert.equal(readCreateOption(context, 'callbackUrl', 0, ''), 'https://example.com/resume');
});

test('a fresh node with nothing set falls through to the defaults', () => {
	const context = contextFor({});

	assert.equal(readCreateOption(context, 'waitForCompletion', 0, false), false);
	assert.equal(readCreateOption(context, 'pollInterval', 0, 5), 5);
	assert.equal(readCreateOption(context, 'maxWait', 0, 300), 300);
	assert.equal(readCreateOption(context, 'callbackUrl', 0, ''), '');
	assert.deepEqual(readCreateOption(context, 'callbackHeaders', 0, {}), {});
});

test('a value deliberately set to a falsy one in Options is not treated as absent', () => {
	// `in` rather than truthiness, because turning Wait for Completion OFF inside
	// Options has to beat a stale `true` left at the top level. A truthiness
	// check would silently keep polling.
	const context = contextFor({ waitForCompletion: true, options: { waitForCompletion: false } });

	assert.equal(readCreateOption(context, 'waitForCompletion', 0, false), false);
});

test('an empty callback address in Options really means send nothing', () => {
	const context = contextFor({ callbackUrl: 'https://old.example.com', options: { callbackUrl: '' } });

	assert.equal(readCreateOption(context, 'callbackUrl', 0, ''), '');
});

test('a non-object Options value falls back instead of throwing', () => {
	// An expression can resolve to something that is not an object. The node must
	// still submit the job rather than fail on a parameter read.
	for (const junk of [null, 'text', 42, ['a']]) {
		const context = contextFor({ maxWait: 600, options: junk });
		assert.equal(readCreateOption(context, 'maxWait', 0, 300), 600, `options: ${JSON.stringify(junk)}`);
	}
});
