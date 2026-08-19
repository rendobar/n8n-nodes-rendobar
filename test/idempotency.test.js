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

// ── Moving off a key Rendobar has already spent ────────────────────────────
//
// `POST /jobs` binds a key to one job and keeps the binding after that job
// ends. Once the job it created has stopped with a code Rendobar itself calls
// retryable, the key can do nothing: it cannot hand back a usable job and it
// cannot start a second one. It answers 409 CONFLICT naming the job instead.
//
// Every component of the automatic key above is stable inside one execution,
// so a DELIBERATE retry of the same submission rebuilds the same key and meets
// that 409 — which is what the node has to get past.

const {
	retryKeyFor,
	spentKeyBudget,
	submitJob,
} = require('../dist/nodes/Rendobar/Rendobar.node.js');
const { describeFailure, spentKeyJobId } = require('../dist/nodes/Rendobar/shared/failure.js');

const NODE = { id: 'node_a', name: 'Rendobar', type: 'rendobar', typeVersion: 1, position: [0, 0] };

/** The 409 body `POST /jobs` sends for a key bound to a job that never ran. */
function spentKeyBody(jobId) {
	return {
		error: {
			code: 'CONFLICT',
			message: `Idempotency key "k" is already bound to job ${jobId}, which failed with a retryable error. Reusing the key cannot create a new job. Retry with a new idempotency key.`,
			details: { jobId },
		},
	};
}

/**
 * An IExecuteFunctions stand-in carrying only what the transport touches, plus
 * the list of idempotency keys the API was actually asked for.
 */
function fakeContext(responses, node = NODE) {
	const keys = [];
	return {
		keys,
		getNode: () => node,
		getCredentials: async () => ({ baseUrl: 'https://api.example.com' }),
		helpers: {
			httpRequestWithAuthentication: async (_credentialType, options) => {
				keys.push(options.body.idempotencyKey);
				const next = responses.shift();
				if (next === undefined) throw new Error('the node made an unexpected extra request');
				return { statusCode: next.statusCode, headers: {}, body: next.body };
			},
		},
	};
}

const SUBMISSION = { type: 'ffmpeg', inputs: {}, params: { command: '-i source output.mp4' } };

test('the 409 that means a spent key is told apart from every other conflict', () => {
	assert.equal(spentKeyJobId(409, spentKeyBody('job_abc123')), 'job_abc123');

	// The other 409s the API sends carry no details at all, so nothing here can
	// mistake a settled job or a webhook endpoint limit for a spent key.
	assert.equal(
		spentKeyJobId(409, { error: { code: 'CONFLICT', message: 'Already cancelled' } }),
		undefined,
	);
	assert.equal(spentKeyJobId(409, { error: { code: 'CONFLICT', details: {} } }), undefined);
	assert.equal(spentKeyJobId(409, null), undefined);
	assert.equal(spentKeyJobId(409, '<html>Conflict</html>'), undefined);
	// And a job ID under any other status or code is not this case.
	assert.equal(spentKeyJobId(404, spentKeyBody('job_x')), undefined);
	assert.equal(
		spentKeyJobId(409, { error: { code: 'GONE', details: { jobId: 'job_x' } } }),
		undefined,
	);
});

test('the replacement key is derived from the base, not chained onto the last one', () => {
	// Chaining would grow the key by ~21 characters per attempt and walk it into
	// the 256 the API accepts. Deriving from the base keeps it one fixed length
	// however many spent keys a single pass walks past.
	const base = 'n8n:exec_1:node_a:0:0:abc';
	assert.equal(retryKeyFor(base, 'job_1').length, retryKeyFor(base, 'job_2').length);
	assert.notEqual(retryKeyFor(base, 'job_1'), retryKeyFor(base, 'job_2'));
	assert.notEqual(retryKeyFor(base, 'job_1'), base);
	// Pure: the same 409 always builds the same replacement, so two deliveries of
	// one attempt still settle on one job.
	assert.equal(retryKeyFor(base, 'job_1'), retryKeyFor(base, 'job_1'));
});

test('a replacement key never collides with another submission', () => {
	// The base already separates two different requests, and the suffix cannot
	// erase that.
	const left = key(toolCall, compress);
	const right = key(toolCall, watermark);
	assert.notEqual(retryKeyFor(left, 'job_1'), retryKeyFor(right, 'job_1'));
	// Nor can a replacement collide with the untouched key of another request.
	assert.notEqual(retryKeyFor(left, 'job_1'), right);
});

test('a replacement key still fits the 256 characters the API accepts', () => {
	const long = {
		type: 'a'.repeat(200),
		inputs: { source: `https://example.com/${'b'.repeat(2000)}.mp4` },
		params: { command: 'c'.repeat(5000) },
	};
	const built = key(
		{
			executionId: 'e'.repeat(40),
			nodeId: '0f8fad5b-d9cb-469f-a165-70867728950e',
			runIndex: 99,
			itemIndex: 9999,
		},
		long,
	);
	const replacement = retryKeyFor(built, 'job_0f8fad5bd9cb469f');
	assert.ok(replacement.length <= 256, `replacement key is ${replacement.length} characters`);
});

test('the budget for walking past spent keys is the retry budget of the node', () => {
	// n8n hands a node no attempt number, so the node cannot know it is on try 3.
	// What it can read is how many tries the workflow allows, and that is exactly
	// how many keys a rebuilt-from-scratch submission could already have spent.
	assert.equal(spentKeyBudget({ ...NODE }), 1, 'nothing can be spent without Retry On Fail');
	assert.equal(spentKeyBudget({ ...NODE, retryOnFail: false, maxTries: 5 }), 1);
	assert.equal(spentKeyBudget({ ...NODE, retryOnFail: true, maxTries: 5 }), 5);
	// n8n's own default when Retry On Fail is switched on and left alone.
	assert.equal(spentKeyBudget({ ...NODE, retryOnFail: true }), 3);
	// A hand-edited workflow must not turn one item into an unbounded run of
	// submissions, and must never leave the loop unable to submit at all.
	assert.equal(spentKeyBudget({ ...NODE, retryOnFail: true, maxTries: 900 }), 10);
	assert.equal(spentKeyBudget({ ...NODE, retryOnFail: true, maxTries: 0 }), 1);
	assert.equal(spentKeyBudget({ ...NODE, retryOnFail: true, maxTries: -4 }), 1);
	assert.equal(spentKeyBudget({ ...NODE, retryOnFail: true, maxTries: '5' }), 3, 'a non-number falls back');
});

test('a submission that is accepted sends the key it was given, once', async () => {
	const context = fakeContext([{ statusCode: 201, body: { data: { id: 'job_1' } } }]);

	const created = await submitJob.call(context, SUBMISSION, 'k-base', 3, 0);

	assert.deepEqual(created, { data: { id: 'job_1' } });
	assert.deepEqual(context.keys, ['k-base']);
});

test('a spent key is replaced and the submission goes through', async () => {
	// The deliberate retry: n8n re-runs this node inside the same execution, the
	// key rebuilds identically, and Rendobar refuses it because the job it made
	// stopped without ever reaching a runner. Resubmitting under a fresh key is
	// what `retryable: true` on that job asked for, and it duplicates nothing.
	const context = fakeContext([
		{ statusCode: 409, body: spentKeyBody('job_dead') },
		{ statusCode: 201, body: { data: { id: 'job_new' } } },
	]);

	const created = await submitJob.call(context, SUBMISSION, 'k-base', 3, 0);

	assert.deepEqual(created, { data: { id: 'job_new' } });
	assert.deepEqual(context.keys, ['k-base', retryKeyFor('k-base', 'job_dead')]);
});

test('a run of spent keys is walked in order, each named by the last answer', async () => {
	// Try 3 of Retry On Fail rebuilds the base key, so it meets the job try 1
	// created, then the job try 2 created. One hop per attempt already spent.
	const context = fakeContext([
		{ statusCode: 409, body: spentKeyBody('job_1') },
		{ statusCode: 409, body: spentKeyBody('job_2') },
		{ statusCode: 201, body: { data: { id: 'job_3' } } },
	]);

	const created = await submitJob.call(context, SUBMISSION, 'k-base', 3, 0);

	assert.deepEqual(created, { data: { id: 'job_3' } });
	assert.deepEqual(context.keys, [
		'k-base',
		retryKeyFor('k-base', 'job_1'),
		retryKeyFor('k-base', 'job_2'),
	]);
});

test('the budget stops the walk and the conflict is reported', async () => {
	// A budget of 1 is what a key the user set by hand gets: the node may replace
	// a key it invented, but never a variant of one its author asserted.
	const context = fakeContext([{ statusCode: 409, body: spentKeyBody('job_dead') }]);

	await assert.rejects(
		() => submitJob.call(context, SUBMISSION, 'order-4417', 1, 0),
		(thrown) => {
			const details = describeFailure(thrown);
			assert.equal(details.code, 'CONFLICT');
			assert.equal(details.httpStatus, 409);
			assert.equal(details.jobId, 'job_dead');
			assert.equal(details.retryable, false, 'repeating the identical call cannot clear it');
			return true;
		},
	);
	assert.deepEqual(context.keys, ['order-4417'], 'the key the user asserted was not varied');
});

test('a conflict that is not a spent key is reported without a second submission', async () => {
	const context = fakeContext([
		{ statusCode: 409, body: { error: { code: 'CONFLICT', message: 'Job is already cancelled' } } },
	]);

	await assert.rejects(() => submitJob.call(context, SUBMISSION, 'k-base', 5, 0));
	assert.deepEqual(context.keys, ['k-base'], 'nothing may be submitted twice on a plain conflict');
});

test('any other rejection is raised as it always was', async () => {
	const context = fakeContext([
		{
			statusCode: 402,
			body: { error: { code: 'INSUFFICIENT_CREDITS', message: 'Balance is non-positive' } },
		},
	]);

	await assert.rejects(
		() => submitJob.call(context, SUBMISSION, 'k-base', 5, 0),
		(thrown) => {
			assert.equal(describeFailure(thrown).code, 'INSUFFICIENT_CREDITS');
			return true;
		},
	);
	assert.deepEqual(context.keys, ['k-base']);
});
