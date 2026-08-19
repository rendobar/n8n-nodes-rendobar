// The narrowing layer that replaced the untyped API boundary. Every guard is a
// total function: it returns undefined rather than throwing or asserting a
// shape nothing checked.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
	arrayAt,
	asObject,
	booleanAt,
	isJsonObject,
	numberAt,
	objectAt,
	objectsAt,
	readJsonParameter,
	readNumber,
	readObject,
	readString,
	readUnixMs,
	stringAt,
	stringsAt,
	unwrapData,
} = require('../dist/nodes/Rendobar/shared/json.js');

test('the object guard rejects arrays and null', () => {
	assert.equal(isJsonObject({ a: 1 }), true);
	assert.equal(isJsonObject([1, 2]), false);
	assert.equal(isJsonObject(null), false);
	assert.equal(isJsonObject('text'), false);
	assert.equal(isJsonObject(undefined), false);
	assert.equal(asObject([1]), undefined);
});

test('typed readers return undefined rather than the wrong type', () => {
	const body = { name: 'ffmpeg', count: 3, ready: true, nested: { a: 1 }, list: [1, 2] };

	assert.equal(stringAt(body, 'name'), 'ffmpeg');
	assert.equal(stringAt(body, 'count'), undefined);
	assert.equal(stringAt(body, 'missing'), undefined);
	assert.equal(numberAt(body, 'count'), 3);
	assert.equal(numberAt(body, 'name'), undefined);
	assert.equal(booleanAt(body, 'ready'), true);
	assert.equal(booleanAt(body, 'count'), undefined);
	assert.deepEqual(objectAt(body, 'nested'), { a: 1 });
	assert.equal(objectAt(body, 'list'), undefined);
	assert.deepEqual(arrayAt(body, 'list'), [1, 2]);
	assert.equal(arrayAt(body, 'nested'), undefined);
});

test('NaN and Infinity are not numbers a response may carry', () => {
	assert.equal(numberAt({ n: Number.NaN }, 'n'), undefined);
	assert.equal(numberAt({ n: Number.POSITIVE_INFINITY }, 'n'), undefined);
});

test('list readers drop entries of the wrong shape instead of failing', () => {
	assert.deepEqual(objectsAt({ data: [{ a: 1 }, 'nope', null, { b: 2 }] }, 'data'), [
		{ a: 1 },
		{ b: 2 },
	]);
	assert.deepEqual(stringsAt({ events: ['a', 3, 'b', null] }, 'events'), ['a', 'b']);
	assert.deepEqual(objectsAt({ data: 'not a list' }, 'data'), []);
	assert.deepEqual(stringsAt(undefined, 'events'), []);
});

test('unwrapData takes the envelope off, or hands back the response itself', () => {
	assert.deepEqual(unwrapData({ data: { id: 'job_1' } }), { id: 'job_1' });
	// POST /assets puts `data` beside a sibling discriminator, so a response with
	// no `data` object still yields something usable.
	assert.deepEqual(unwrapData({ status: 'deduplicated' }), { status: 'deduplicated' });
	assert.equal(unwrapData('text'), undefined);
});

test('parameter readers survive whatever getNodeParameter hands back', () => {
	assert.equal(readString({ status: 'complete' }, 'status'), 'complete');
	// An unset n8n parameter is an empty string, which is not a filter.
	assert.equal(readString({ status: '' }, 'status'), undefined);
	assert.equal(readString(undefined, 'status'), undefined);
	assert.equal(readString('a string', 'status'), undefined);
	assert.equal(readNumber({ limit: 50 }, 'limit'), 50);
	assert.equal(readNumber({ limit: '50' }, 'limit'), undefined);
	assert.deepEqual(readObject({ value: { crf: 28 } }, 'value'), { crf: 28 });
	assert.equal(readObject({ value: null }, 'value'), undefined);
	assert.equal(readObject({ value: [1] }, 'value'), undefined);
});

test('a JSON parameter accepts typed text', () => {
	const result = readJsonParameter('{ "source": "https://example.com/video.mp4" }');
	assert.equal(result.ok, true);
	assert.deepEqual(result.value, { source: 'https://example.com/video.mp4' });
});

test('a JSON parameter accepts an object an expression produced', () => {
	const result = readJsonParameter({ source: 'https://example.com/video.mp4' });
	assert.equal(result.ok, true);
	assert.deepEqual(result.value, { source: 'https://example.com/video.mp4' });
});

test('an empty JSON parameter means no inputs, not a stopped item', () => {
	for (const empty of ['', '   ', undefined, null]) {
		const result = readJsonParameter(empty);
		assert.equal(result.ok, true);
		assert.deepEqual(result.value, {});
	}
});

test('a JSON parameter reports why it could not be used', () => {
	// Reported rather than thrown, so the node can name its own parameter.
	assert.deepEqual(readJsonParameter('{ not json }'), { ok: false, reason: 'unparsable' });
	assert.deepEqual(readJsonParameter('[1, 2]'), { ok: false, reason: 'notAnObject' });
	assert.deepEqual(readJsonParameter('"a string"'), { ok: false, reason: 'notAnObject' });
	assert.deepEqual(readJsonParameter('42'), { ok: false, reason: 'notAnObject' });
	assert.deepEqual(readJsonParameter([1, 2]), { ok: false, reason: 'notAnObject' });
	assert.deepEqual(readJsonParameter(7), { ok: false, reason: 'notAnObject' });
});

test('a date-time parameter is read from any ISO 8601 form n8n emits', () => {
	assert.equal(readUnixMs('2026-08-19T12:00:00Z'), Date.parse('2026-08-19T12:00:00Z'));
	assert.equal(readUnixMs('2026-08-19T12:00:00.000+02:00'), Date.parse('2026-08-19T12:00:00.000+02:00'));
	assert.equal(readUnixMs('2026-08-19'), Date.parse('2026-08-19'));
	assert.equal(readUnixMs(1755600000000), 1755600000000);
});

test('an unreadable date-time is reported rather than silently dropped', () => {
	assert.equal(readUnixMs('last tuesday'), undefined);
	assert.equal(readUnixMs(''), undefined);
	assert.equal(readUnixMs(undefined), undefined);
});
