// The per-job callback is the only path that reaches Rendobar's nine-hour job
// ceiling without holding an n8n worker open, so the address it is given has to
// be one Rendobar can actually reach. Everything rejected here would otherwise
// come back as a 400 that does not mention n8n at all.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
	buildCallback,
	readCallbackHeaders,
	waitAndCallbackConflict,
} = require('../dist/nodes/Rendobar/shared/callback.js');

// The n8n guidelines keep these out of anything shown to a user.
const BANNED_WORDS = /\b(error|errors|problem|problems|failure|failures|failed|mistake|mistakes)\b/i;

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
// The Create options moved into an 'Options' collection in 0.5.0, so a lookup
// by name has to descend into it. Kept as one helper rather than repeated
// inline so a future move updates one place.
const collectionChildren = (name) => {
	const collection = properties.find((property) => property.type === 'collection' && property.name === name);
	return collection ? collection.options : [];
};
const createOption = (name) => collectionChildren('options').find((option) => option.name === name);


test('Create takes a callback address, on the Job resource only', () => {
	const url = createOption('callbackUrl');
	assert.ok(url, 'no Callback URL parameter');
	assert.equal(url.type, 'string');
	assert.equal(url.default, '', 'sending no callback has to be the default');
	// The Job/Create gate moved onto the collection in 0.5.0. Repeating it on a
	// child would be dead weight at best and, if the two ever disagreed, a field
	// that never renders.
	const optionsCollection = properties.find((property) => property.name === 'options');
	assert.deepEqual(optionsCollection.displayOptions.show.operation, ['create']);
	assert.deepEqual(optionsCollection.displayOptions.show.resource, ['job']);
	// The whole point is the Wait node pairing, so the example has to be it.
	assert.match(url.placeholder, /\$execution\.resumeUrl/);
	assert.match(url.description, /Wait node/);
});

test('the callback hint names the two Wait node settings the recipe needs', () => {
	const { hint } = createOption('callbackUrl');
	// The Wait node's resume webhook answers GET by default and Rendobar posts,
	// and a method mismatch is answered with a 404 that names nothing. It is the
	// one setting that decides whether any of this works.
	assert.match(hint, /POST/);
	// And this is the one that decides what happens when the call never lands.
	// Without it a Wait node on a resume URL has no ceiling at all, so an
	// execution that misses the delivery window parks for good.
	assert.match(hint, /Limit Wait Time/);
	assert.doesNotMatch(hint, BANNED_WORDS);
});

test('no copy promises a delivery the retry window cannot keep', () => {
	// Delivery is five retries over about five minutes and then nothing at all.
	// Wording that reads as a guarantee is exactly what stops a user setting the
	// Wait node's own limit, which is the only thing that releases a parked
	// execution once the window has closed.
	const callbackUrl = createOption('callbackUrl');
	const overclaim = /\bnever\b|\balways\b|\bguarantee/i;

	for (const copy of [callbackUrl.description, callbackUrl.hint]) {
		assert.doesNotMatch(copy, overclaim, `callback copy overclaims delivery: ${copy}`);
	}
});

test('the two delivery routes are refused together, and each is fine alone', () => {
	// Behaviour, not wording. This is the combination that parks an execution for
	// good, and it is answered before the job is submitted.
	assert.ok(waitAndCallbackConflict(true, true), 'both together must be refused');

	assert.equal(waitAndCallbackConflict(true, false), undefined, 'a callback alone is fine');
	assert.equal(waitAndCallbackConflict(false, true), undefined, 'polling alone is fine');
	assert.equal(waitAndCallbackConflict(false, false), undefined, 'neither is fine');
});

test('the refusal names both parameters and says which one to drop', () => {
	const clash = waitAndCallbackConflict(true, true);

	// n8n renders `parameter` as the thing at fault, so it has to be the one the
	// user is being told to turn off.
	assert.equal(clash.parameter, 'Wait for Completion');
	assert.match(clash.what, /Callback URL/);
	assert.match(clash.how, /Wait for Completion/);
	assert.match(clash.how, /Callback URL/);

	for (const copy of [clash.what, clash.how]) {
		assert.doesNotMatch(copy, BANNED_WORDS, `refusal copy uses a banned word: ${copy}`);
	}
});

test('a workflow that already sets both still shows both parameters', () => {
	// The combination is answered with a message, not by hiding half of it.
	// A parameter that vanishes leaves someone who already built the workflow
	// reading a panel that no longer matches what they saved, and a stored value
	// behind a hidden field is read differently across n8n versions.
	for (const name of ['waitForCompletion', 'callbackUrl']) {
		const property = createOption(name);
		const gates = { ...property.displayOptions?.show, ...property.displayOptions?.hide };
		assert.ok(
			!('callbackUrl' in gates) && !('waitForCompletion' in gates),
			`${name} is gated on the other half of the pair`,
		);
	}
});

test('both descriptions warn about the pairing before it is built', () => {
	// The run-time refusal is the backstop. This copy is what stops the workflow
	// being built that way in the first place.
	assert.match(createOption('waitForCompletion').description, /Callback URL/);
	assert.match(createOption('callbackUrl').description, /Wait for Completion/);
});

test('Callback Headers are opt-in and never appear unbidden', () => {
	// Until 0.5.0 this was gated with `hide: { callbackUrl: [''] }`, so the field
	// only appeared once an address was typed. Inside the Options collection that
	// gate is redundant and worse than redundant: a child never renders until the
	// user picks it from 'Add Option', and a sibling reference from inside a
	// collection is not something every n8n version resolves the same way. The
	// clutter the gate existed to prevent is what the collection already fixes.
	const headerParam = createOption('callbackHeaders');
	assert.ok(headerParam, 'no Callback Headers parameter');
	assert.equal(headerParam.type, 'fixedCollection');
	assert.equal(headerParam.typeOptions.multipleValues, true);
	assert.equal(
		headerParam.displayOptions,
		undefined,
		'a sibling-gated child inside a collection is the case that silently never renders',
	);

	const [group] = headerParam.options;
	assert.equal(group.name, 'header', 'the reader expects rows under `header`');
	assert.deepEqual(
		group.values.map((value) => value.name),
		['name', 'value'],
	);
	// A header value is usually a token, so it should not sit on screen in clear.
	assert.equal(group.values[1].typeOptions.password, true);
});

test('the delivery controls live together under Options, alphabetised', () => {
	// They used to be ordered by intent: polling first as the short-job answer,
	// the callback below it as the long-job alternative. Inside a collection that
	// choice is not ours. n8n lints collection children into alphabetical order
	// (node-param-collection-type-unsorted-items) because the user meets them as
	// a dropdown, not as a column, so intent-ordering has nothing to convey.
	//
	// What still has to hold is that all six are in one place and none escaped.
	const names = collectionChildren('options').map((option) => option.name);

	assert.deepEqual(
		[...names].sort(),
		['callbackHeaders', 'callbackUrl', 'idempotencyKey', 'maxWait', 'pollInterval', 'waitForCompletion'],
		'a Create option is missing from the collection or an extra one arrived',
	);
	assert.deepEqual(
		collectionChildren('options').map((option) => option.displayName),
		[...collectionChildren('options').map((option) => option.displayName)].sort(),
		'n8n requires collection children in alphabetical order by display name',
	);
});

test('nothing that moved into Options is still declared at the top level', () => {
	// A parameter declared in both places is read from whichever n8n resolves
	// first, which is the kind of thing that works in testing and diverges in a
	// real workflow.
	const top = properties.map((property) => property.name);
	for (const moved of ['waitForCompletion', 'pollInterval', 'maxWait', 'callbackUrl', 'callbackHeaders', 'idempotencyKey']) {
		assert.ok(!top.includes(moved), `${moved} is declared at the top level and inside Options`);
	}
});
