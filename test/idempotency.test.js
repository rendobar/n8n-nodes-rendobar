// The idempotency key is the one thing in this node that can silently return
// the WRONG job rather than raising: `POST /jobs` looks a repeated key up on
// (org, key) alone and never compares payloads, so a colliding key hands back
// whatever was submitted first, with the second submission's parameters thrown
// away and no error anywhere.
const test = require('node:test');
const assert = require('node:assert/strict');

const { fingerprint, stableStringify } = require('../dist/nodes/Rendobar/Rendobar.node.js');

/** Mirrors how execute() assembles the key. */
function key(context, submission) {
	const { executionId, nodeId, runIndex, itemIndex } = context;
	return `n8n:${executionId}:${nodeId}:${runIndex}:${itemIndex}:${fingerprint(submission)}`;
}

const toolCall = { executionId: 'exec_1', nodeId: 'node_a', runIndex: 0, itemIndex: 0 };

const compress = {
	type: 'ffmpeg',
	inputs: { source: 'https://example.com/a.mp4' },
	params: { command: '-i source -crf 28 output.mp4' },
};

const watermark = {
	type: 'ffmpeg',
	inputs: { source: 'https://example.com/b.mp4' },
	params: { command: '-i source -vf drawtext=text=hi output.mp4' },
};

test('two different requests in one execution get different keys', () => {
	// The AI-tool case: an agent calls the node twice inside one execution, so
	// execution, node, run and item are all identical. Before the fingerprint
	// these collided and the second call returned the first job.
	assert.notEqual(key(toolCall, compress), key(toolCall, watermark));
});

test('differing only in inputs, or only in params, is still a different key', () => {
	const base = key(toolCall, compress);
	assert.notEqual(base, key(toolCall, { ...compress, inputs: { source: 'https://example.com/z.mp4' } }));
	assert.notEqual(base, key(toolCall, { ...compress, params: { command: '-i source output.mp4' } }));
	assert.notEqual(base, key(toolCall, { ...compress, type: 'probe' }));
});

test('a retry of the same request reuses the same key', () => {
	// This is the whole point of the key: n8n retrying the step must settle on
	// the job the first attempt created rather than paying for a second one.
	assert.equal(key(toolCall, compress), key(toolCall, compress));

	// Rebuilt from separate objects, as a real retry would.
	const rebuilt = {
		type: 'ffmpeg',
		inputs: { source: 'https://example.com/a.mp4' },
		params: { command: '-i source -crf 28 output.mp4' },
	};
	assert.equal(key(toolCall, compress), key(toolCall, rebuilt));
});

test('key order does not change the fingerprint', () => {
	// n8n rebuilds a resource-mapper value from stored parameters each run, so a
	// fingerprint sensitive to insertion order would drift between runs and
	// defeat the retry guarantee above.
	const forward = { type: 'ffmpeg', inputs: { a: 1, b: 2 }, params: { x: 1, y: 2 } };
	const reversed = { params: { y: 2, x: 1 }, inputs: { b: 2, a: 1 }, type: 'ffmpeg' };
	assert.equal(fingerprint(forward), fingerprint(reversed));
});

test('array order does change the fingerprint', () => {
	// Order is meaningful in a list of inputs, so it must not be normalised away.
	assert.notEqual(fingerprint({ a: [1, 2] }), fingerprint({ a: [2, 1] }));
});

test('the ordinary separators still work', () => {
	// Two nodes in one workflow, two passes of a loop, two items of one pass.
	const same = compress;
	assert.notEqual(key(toolCall, same), key({ ...toolCall, nodeId: 'node_b' }, same));
	assert.notEqual(key(toolCall, same), key({ ...toolCall, runIndex: 1 }, same));
	assert.notEqual(key(toolCall, same), key({ ...toolCall, itemIndex: 1 }, same));
	assert.notEqual(key(toolCall, same), key({ ...toolCall, executionId: 'exec_2' }, same));
});

test('the key stays inside the 256 characters the API accepts', () => {
	const long = {
		type: 'a'.repeat(200),
		inputs: { source: `https://example.com/${'b'.repeat(2000)}.mp4` },
		params: { command: 'c'.repeat(5000) },
	};
	const built = key(
		{ executionId: 'e'.repeat(40), nodeId: '0f8fad5b-d9cb-469f-a165-70867728950e', runIndex: 99, itemIndex: 9999 },
		long,
	);
	assert.ok(built.length <= 256, `key is ${built.length} characters`);
});

test('stableStringify handles the values a submission can carry', () => {
	assert.equal(stableStringify(null), 'null');
	assert.equal(stableStringify(42), '42');
	assert.equal(stableStringify(true), 'true');
	assert.equal(stableStringify('hi'), '"hi"');
	assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
	assert.equal(stableStringify([1, { b: 1, a: 2 }]), '[1,{"a":2,"b":1}]');
	assert.equal(stableStringify({ nested: { z: [1, 2], a: null } }), '{"nested":{"a":null,"z":[1,2]}}');
});

test('fingerprints are short, stable and URL-safe', () => {
	const value = fingerprint(compress);
	assert.match(value, /^[0-9a-z]+$/, 'must be safe to put in a header-bound string');
	assert.ok(value.length <= 16);
	assert.equal(value, fingerprint(compress));
});

test('fingerprints spread across many distinct submissions', () => {
	// A collision here would resurrect the bug for the two payloads involved.
	const seen = new Set();
	for (let index = 0; index < 5000; index++) {
		seen.add(
			fingerprint({
				type: 'ffmpeg',
				inputs: { source: `https://example.com/${index}.mp4` },
				params: { command: `-i source -crf ${index % 52} output.mp4` },
			}),
		);
	}
	assert.equal(seen.size, 5000, 'two distinct submissions fingerprinted the same');
});
