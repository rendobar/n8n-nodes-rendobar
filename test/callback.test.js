// The per-job callback is the only path that reaches Rendobar's nine-hour job
// ceiling without holding an n8n worker open, so the address it is given has to
// be one Rendobar can actually reach. Everything rejected here would otherwise
// come back as a 400 that does not mention n8n at all.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
	buildCallback,
	readCallbackHeaders,
} = require('../dist/nodes/Rendobar/shared/callback.js');

const RESUME_URL = 'https://n8n.example.com/webhook-waiting/1042';

/** Shapes a Callback Headers value the way the fixedCollection stores it. */
function headers(...rows) {
	return { header: rows };
}

test('no callback URL means no callback on the submission', () => {
	for (const empty of ['', '   ', undefined, null, 42, {}]) {
		const result = buildCallback(empty, {});
		assert.equal(result.ok, true, `${JSON.stringify(empty)} should not be an error`);
		assert.equal(result.callback, undefined);
	}
});

test('an https address becomes the callback Rendobar takes', () => {
	const result = buildCallback(`  ${RESUME_URL}  `, {});
	assert.equal(result.ok, true);
	// Trimmed, and with no headers key at all rather than an empty object.
	assert.deepEqual(result.callback, { url: RESUME_URL });
});

test('a plain http address is refused with the tunnel advice', () => {
	const result = buildCallback('http://n8n.example.com/webhook-waiting/7', {});
	assert.equal(result.ok, false);
	assert.equal(result.parameter, 'Callback URL');
	assert.match(result.what, /https/);
	assert.match(result.how, /tunnel/);
});

test('an address only this machine can reach is refused, with the reason', () => {
	const unreachable = [
		'https://localhost:5678/webhook-waiting/7',
		'https://127.0.0.1:5678/webhook-waiting/7',
		'https://192.168.1.20/webhook-waiting/7',
		'https://10.0.0.4/webhook-waiting/7',
		'https://172.16.3.9/webhook-waiting/7',
		'https://169.254.169.254/latest/meta-data',
		'https://n8n.local/webhook-waiting/7',
		'https://n8n.internal/webhook-waiting/7',
		'https://[::1]:5678/webhook-waiting/7',
	];

	for (const url of unreachable) {
		const result = buildCallback(url, {});
		assert.equal(result.ok, false, `${url} should be refused`);
		assert.equal(result.parameter, 'Callback URL');
		assert.match(result.how, /tunnel/);
	}
});

test('a public address that merely looks private is allowed', () => {
	// 172.32 is outside the private 172.16-172.31 block, and a hostname that
	// merely contains "localhost" is not localhost.
	for (const url of ['https://172.32.0.1/hook', 'https://localhost.example.com/hook']) {
		assert.equal(buildCallback(url, {}).ok, true, `${url} should be allowed`);
	}
});

test('something that is not a web address at all says so', () => {
	const result = buildCallback('resumeUrl', {});
	assert.equal(result.ok, false);
	assert.equal(result.parameter, 'Callback URL');
	// The advice has to name the expression, because that is what the user needs.
	assert.match(result.how, /\$execution\.resumeUrl/);
});

test('headers are sent under the names they were given', () => {
	const result = buildCallback(
		RESUME_URL,
		headers({ name: 'Authorization', value: 'Bearer abc' }, { name: 'X-Api-Key', value: 'k' }),
	);

	assert.equal(result.ok, true);
	assert.deepEqual(result.callback, {
		url: RESUME_URL,
		headers: { Authorization: 'Bearer abc', 'X-Api-Key': 'k' },
	});
});

test('a header row with no name is dropped rather than sent empty', () => {
	const result = buildCallback(
		RESUME_URL,
		headers({ name: '  ', value: 'v' }, { value: 'orphan' }, { name: 'Keep', value: '' }),
	);

	assert.equal(result.ok, true);
	assert.deepEqual(result.callback.headers, { Keep: '' });
});

test("a header Rendobar keeps for itself is reported, not silently dropped", () => {
	// Sending it is rejected by the API, and dropping it would leave the user's
	// receiver refusing calls for a header it never got.
	for (const name of ['X-Rendobar-Signature', 'x-rendobar-event']) {
		const result = buildCallback(RESUME_URL, headers({ name, value: 'v' }));
		assert.equal(result.ok, false, `${name} should be refused`);
		assert.equal(result.parameter, 'Callback Headers');
		assert.match(result.what, new RegExp(name));
	}
});

test('the URL is checked before the headers are', () => {
	// Otherwise a user with both wrong fixes the header first and then hits the
	// address problem, which is the one that matters.
	const result = buildCallback('http://localhost:5678/x', headers({ name: 'X-Rendobar-Y', value: '' }));
	assert.equal(result.ok, false);
	assert.equal(result.parameter, 'Callback URL');
});

test('the header reader survives a value that is not the collection shape', () => {
	for (const junk of [undefined, null, 'text', [], { header: 'not-an-array' }, { header: [1, 2] }]) {
		const { headers: read, reserved } = readCallbackHeaders(junk);
		assert.deepEqual(read, {}, `${JSON.stringify(junk)} should read as no headers`);
		assert.equal(reserved, undefined);
	}
});

// ── The two parameters behind it ──────────────────────────────────────────

const { Rendobar } = require('../dist/nodes/Rendobar/Rendobar.node.js');

const properties = new Rendobar().description.properties;
const byName = (name) => properties.find((property) => property.name === name);

test('Create takes a callback address, on the Job resource only', () => {
	const url = byName('callbackUrl');
	assert.ok(url, 'no Callback URL parameter');
	assert.equal(url.type, 'string');
	assert.equal(url.default, '', 'sending no callback has to be the default');
	assert.deepEqual(url.displayOptions.show.operation, ['create']);
	assert.deepEqual(url.displayOptions.show.resource, ['job']);
	// The whole point is the Wait node pairing, so the example has to be it.
	assert.match(url.placeholder, /\$execution\.resumeUrl/);
	assert.match(url.description, /Wait node/);
});

test('the callback hint says a job that stops still calls back', () => {
	// Terminal events cannot be filtered out on Rendobar's side, which is the
	// reason a parked execution can never be left waiting forever. The hint says
	// so without any of the words n8n's guidelines keep out of node copy.
	const { hint } = byName('callbackUrl');
	assert.match(hint, /stopped/);
	assert.match(hint, /cancelled/);
	// The Wait node's resume webhook answers GET by default and Rendobar posts,
	// and a method mismatch is answered with a 404 that names nothing. It is the
	// one setting that decides whether any of this works.
	assert.match(hint, /POST/);
	assert.doesNotMatch(hint, /(error|problem|failure|failed|mistake)/i);
});

test('Callback Headers appear only once an address has been given', () => {
	const headerParam = byName('callbackHeaders');
	assert.ok(headerParam, 'no Callback Headers parameter');
	assert.equal(headerParam.type, 'fixedCollection');
	assert.equal(headerParam.typeOptions.multipleValues, true);
	assert.deepEqual(headerParam.displayOptions.hide.callbackUrl, ['']);

	const [group] = headerParam.options;
	assert.equal(group.name, 'header', 'the reader expects rows under `header`');
	assert.deepEqual(
		group.values.map((value) => value.name),
		['name', 'value'],
	);
	// A header value is usually a token, so it should not sit on screen in clear.
	assert.equal(group.values[1].typeOptions.password, true);
});

test('the callback parameters sit after the polling ones', () => {
	// Polling is the short-job answer and stays first; the callback is what a
	// long job needs, and reads as the alternative below it.
	const order = properties.map((property) => property.name);
	assert.ok(order.indexOf('callbackUrl') > order.indexOf('maxWait'));
	assert.ok(order.indexOf('callbackHeaders') > order.indexOf('callbackUrl'));
});
