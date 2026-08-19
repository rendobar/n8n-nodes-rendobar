// Pins the retry, backoff and chunking rules. These are the parts of the
// transport that have no n8n context to stand in for, so they are exercised
// directly against the build output.
const test = require('node:test');
const assert = require('node:assert/strict');

const { describeFailure } = require('../dist/nodes/Rendobar/shared/failure.js');
const {
	assertWholeFileSent,
	chunkStream,
	MAX_ATTEMPTS,
	parseRetryAfter,
	REQUEST_TIMEOUT_MS,
	retryDelayMs,
	shouldRetryStatus,
	TRANSFER_TIMEOUT_MS,
} = require('../dist/nodes/Rendobar/shared/transport.js');

async function collect(iterable) {
	const chunks = [];
	for await (const chunk of iterable) chunks.push(chunk);
	return chunks;
}

async function* fromBuffers(...buffers) {
	for (const buffer of buffers) yield buffer;
}

test('every request carries a timeout', () => {
	// n8n's HTTP helper has none of its own, so a stalled socket would otherwise
	// hold the execution open indefinitely.
	assert.equal(REQUEST_TIMEOUT_MS, 30_000);
	assert.ok(TRANSFER_TIMEOUT_MS > REQUEST_TIMEOUT_MS, 'a file transfer needs a longer budget');
	assert.equal(MAX_ATTEMPTS, 3);
});

test('a throttled request is always safe to repeat', () => {
	assert.equal(shouldRetryStatus(429, false), true);
	assert.equal(shouldRetryStatus(429, true), true);
});

test('a stalled server is repeated only when repeating cannot duplicate anything', () => {
	for (const status of [500, 502, 503, 504]) {
		assert.equal(shouldRetryStatus(status, true), true, `${status} idempotent`);
		assert.equal(shouldRetryStatus(status, false), false, `${status} non-idempotent`);
	}
});

test('a rejected request is never repeated', () => {
	for (const status of [200, 201, 400, 401, 402, 403, 404, 409, 413, 422, 501]) {
		assert.equal(shouldRetryStatus(status, true), false, `${status} should not repeat`);
	}
});

test('Retry-After is read in both forms RFC 9110 allows', () => {
	const now = Date.parse('2026-08-19T12:00:00Z');

	assert.equal(parseRetryAfter('120', now), 120);
	assert.equal(parseRetryAfter('  30 ', now), 30);
	// The HTTP-date form, which the Rendobar SDK itself does not handle.
	assert.equal(parseRetryAfter('Wed, 19 Aug 2026 12:01:00 GMT', now), 60);
	// A date already in the past never yields a negative wait.
	assert.equal(parseRetryAfter('Wed, 19 Aug 2026 11:00:00 GMT', now), 0);
	// Node hands a repeated header back as an array.
	assert.equal(parseRetryAfter(['45'], now), 45);
});

test('an absent or unreadable Retry-After falls back to the backoff', () => {
	const now = Date.now();
	assert.equal(parseRetryAfter(undefined, now), undefined);
	assert.equal(parseRetryAfter('', now), undefined);
	assert.equal(parseRetryAfter('   ', now), undefined);
	assert.equal(parseRetryAfter('soon please', now), undefined);
	assert.equal(parseRetryAfter([], now), undefined);
});

test('Retry-After wins over the backoff and is capped', () => {
	assert.equal(retryDelayMs(1, 3), 3000);
	// A server asking for an hour must not hold the execution for an hour.
	assert.equal(retryDelayMs(1, 3600), 30_000);
});

test('backoff grows per attempt and always carries jitter', () => {
	// Jitter keeps a batch of items from retrying on the same tick and rebuilding
	// the burst that caused the throttling, so the delay is a range, not a value.
	for (const [attempt, low, high] of [
		[1, 500, 1000],
		[2, 1000, 2000],
		[3, 2000, 4000],
	]) {
		for (let run = 0; run < 200; run++) {
			const delay = retryDelayMs(attempt);
			assert.ok(delay >= low, `attempt ${attempt} delay ${delay} below ${low}`);
			assert.ok(delay < high, `attempt ${attempt} delay ${delay} at or above ${high}`);
		}
	}

	// And it never runs away on a long retry chain.
	assert.ok(retryDelayMs(20) <= 60_000);
});

test('chunkStream regroups a stream into fixed-size buffers', async () => {
	const chunks = await collect(
		chunkStream(fromBuffers(Buffer.from('abcde'), Buffer.from('fghij')), 4),
	);
	assert.deepEqual(
		chunks.map((chunk) => chunk.toString()),
		['abcd', 'efgh', 'ij'],
	);
});

test('chunkStream never yields more than the requested size', async () => {
	// This is the property that bounds memory: one part at a time, whatever the
	// size of the file behind the stream.
	const source = fromBuffers(
		Buffer.alloc(1000, 1),
		Buffer.alloc(7, 2),
		Buffer.alloc(3000, 3),
	);
	const chunks = await collect(chunkStream(source, 256));

	for (const chunk of chunks) {
		assert.ok(chunk.length <= 256, `yielded ${chunk.length} bytes for a 256-byte ceiling`);
	}
	assert.equal(
		chunks.reduce((total, chunk) => total + chunk.length, 0),
		4007,
		'no bytes lost or duplicated',
	);
});

test('chunkStream handles a single buffer smaller than the chunk size', async () => {
	const chunks = await collect(chunkStream(fromBuffers(Buffer.from('hi')), 1024));
	assert.equal(chunks.length, 1);
	assert.equal(chunks[0].toString(), 'hi');
});

test('chunkStream yields nothing for an empty stream', async () => {
	assert.deepEqual(await collect(chunkStream(fromBuffers(), 16)), []);
});

test('chunkStream splits one oversized buffer into whole parts', async () => {
	const chunks = await collect(chunkStream(fromBuffers(Buffer.alloc(10, 9)), 3));
	assert.deepEqual(
		chunks.map((chunk) => chunk.length),
		[3, 3, 3, 1],
	);
});

test('a file that reads back a different length is caught, not silently truncated', () => {
	// Rendobar sizes the upload from the byte count declared at init, so a
	// mismatch would assemble a wrong object without anyone complaining.
	const node = { id: 'n1', name: 'Rendobar', type: 'rendobar', typeVersion: 1, position: [0, 0] };

	assert.throws(() => assertWholeFileSent(node, 900, 1000, 0), (error) => {
		assert.match(error.message, /1000 bytes but 900 were read/);
		assert.match(error.message, /'Input Binary Field'/);
		assert.ok(error.description);
		return true;
	});

	// More bytes than declared is just as wrong as fewer.
	assert.throws(() => assertWholeFileSent(node, 1100, 1000, 0));

	// The matching case is silent.
	assert.equal(assertWholeFileSent(node, 1000, 1000, 0), undefined);
});

test('the size guard reports branchable details like everything else', () => {
	const node = { id: 'n1', name: 'Rendobar', type: 'rendobar', typeVersion: 1, position: [0, 0] };
	try {
		assertWholeFileSent(node, 1, 2, 0);
		assert.fail('expected it to raise');
	} catch (error) {
		const details = describeFailure(error);
		assert.equal(details.code, 'FILE_SIZE_CHANGED');
		assert.equal(details.retryable, true);
	}
});

test('a full queue is never retried inline', () => {
	// QUEUE_FULL answers 429, but unlike RATE_LIMITED it is raised after the
	// compose-assist window has already probed the inputs and run a model, both
	// of which are billed. Retrying re-bills all of it, and a queue does not
	// drain inside a backoff measured in seconds.
	assert.equal(shouldRetryStatus(429, true, 'QUEUE_FULL'), false);
	assert.equal(shouldRetryStatus(429, false, 'QUEUE_FULL'), false);

	// The other 429 is raised by middleware before anything ran, so it is free
	// to repeat.
	assert.equal(shouldRetryStatus(429, false, 'RATE_LIMITED'), true);
	assert.equal(shouldRetryStatus(429, false, undefined), true);
});

test('a source longer than declared is caught even when the parts divide evenly', () => {
	// The byte count alone cannot see this: every part comes back full, so the
	// total matches the declaration exactly while the remainder never ships.
	const node = { id: 'n1', name: 'Rendobar', type: 'rendobar', typeVersion: 1, position: [0, 0] };

	assert.throws(
		() => assertWholeFileSent(node, 1000, 1000, 0, true),
		(error) => {
			assert.match(error.message, /more than 1000 were read/);
			return true;
		},
	);

	// And the ordinary matching case still passes.
	assert.equal(assertWholeFileSent(node, 1000, 1000, 0, false), undefined);
});
