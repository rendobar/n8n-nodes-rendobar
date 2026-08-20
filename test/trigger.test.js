// Guards the two things the Rendobar Trigger sends to POST /webhooks/endpoints
// that the API validates strictly: the endpoint name's 1-50 character bound,
// and the event values, which must be members of the API's WEBHOOK_EVENT_TYPES.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
	buildEndpointName,
	RendobarTrigger,
} = require('../dist/nodes/RendobarTrigger/RendobarTrigger.node.js');

// Mirrors WEBHOOK_EVENT_TYPES in the Rendobar API. The create-endpoint schema
// rejects anything outside this set.
const API_EVENT_TYPES = [
	'job.created',
	'job.started',
	'job.completed',
	'job.failed',
	'job.cancelled',
	'balance.low',
	'balance.depleted',
];

test('endpoint name combines workflow and node, and stays within 50 chars', () => {
	assert.equal(
		buildEndpointName('Render pipeline', 'Rendobar Trigger'),
		'n8n: Render pipeline / Rendobar Trigger',
	);
	assert.ok(buildEndpointName('Render pipeline', 'Rendobar Trigger').length <= 50);
});

test('endpoint name truncates a long workflow name instead of failing validation', () => {
	const name = buildEndpointName('A'.repeat(200), 'Rendobar Trigger');
	assert.equal(name.length, 50);
});

test('endpoint name is never empty, even with no workflow or node name', () => {
	assert.equal(buildEndpointName(undefined, undefined), 'n8n');
	assert.equal(buildEndpointName('', '   '), 'n8n');
	assert.ok(buildEndpointName(undefined, undefined).length >= 1);
});

test('every event the node offers is accepted by the API', () => {
	const properties = new RendobarTrigger().description.properties;
	const events = properties.find((property) => property.name === 'events');
	assert.ok(events, 'events parameter missing');
	for (const option of events.options) {
		assert.ok(
			API_EVENT_TYPES.includes(option.value),
			`${option.value} is not a Rendobar webhook event`,
		);
	}
});

test('the default event selection is a subset of the offered events', () => {
	const properties = new RendobarTrigger().description.properties;
	const events = properties.find((property) => property.name === 'events');
	const offered = events.options.map((option) => option.value);
	for (const value of events.default) {
		assert.ok(offered.includes(value), `${value} defaulted but not offered`);
	}
});

const { registrationMatches } = require('../dist/nodes/RendobarTrigger/RendobarTrigger.node.js');

const wanted = {
	url: 'https://n8n.example.com/webhook/abc',
	events: ['job.completed', 'job.failed'],
};

test('a registration that already matches is left alone', () => {
	assert.equal(
		registrationMatches(
			{ url: wanted.url, events: ['job.failed', 'job.completed'], active: true },
			wanted,
		),
		true,
		'event order must not matter',
	);
});

test('a drifted registration is reported so it can be corrected', () => {
	// Changing the selected events, or moving the n8n instance, leaves Rendobar
	// delivering the wrong thing to the wrong place until this notices.
	assert.equal(
		registrationMatches({ url: wanted.url, events: ['job.completed'], active: true }, wanted),
		false,
		'a shorter event list is drift',
	);
	assert.equal(
		registrationMatches(
			{ url: wanted.url, events: ['job.completed', 'job.started'], active: true },
			wanted,
		),
		false,
		'a different event is drift',
	);
	assert.equal(
		registrationMatches(
			{ url: 'https://old.example.com/webhook/abc', events: wanted.events, active: true },
			wanted,
		),
		false,
		'a moved webhook address is drift',
	);
	assert.equal(
		registrationMatches({ url: wanted.url, events: wanted.events, active: false }, wanted),
		false,
		'an endpoint Rendobar disabled is drift',
	);
	assert.equal(
		registrationMatches({ events: wanted.events, active: true }, wanted),
		false,
		'an endpoint with no address is drift',
	);
});

test('the trigger description says what it fires on', () => {
	// n8n's node details panel takes its headline from the trigger, so this one
	// line stands for the whole package. A generic "when a Rendobar event fires"
	// leaves a reader knowing nothing about the events and reads as a package
	// that only listens.
	const { description } = new RendobarTrigger().description;

	assert.notEqual(description, 'Starts the workflow when a Rendobar event fires');
	assert.match(description, /^Starts the workflow when /);

	// Both event families the node offers have to be recognisable in it, or the
	// headline is specific about half the surface and silent about the other.
	assert.match(description, /\bjob\b/i, 'the job events are not named');
	assert.match(description, /\bbalance\b/i, 'the balance events are not named');

	// The writing rules this repo follows: no em-dash, no semicolons in prose.
	assert.equal(/[—;]/.test(description), false, `"${description}" uses banned punctuation`);
});

test('the trigger deliberately does not advertise itself as an AI tool', () => {
	// A trigger cannot be invoked by an agent, and n8n's type only allows `true`,
	// so the only way to say no is to leave the flag off.
	assert.equal(new RendobarTrigger().description.usableAsTool, undefined);
});

// The address n8n hands a node is not the address that reaches it again.
//
// n8n writes a production webhook path with the node name percent-encoded and
// stores that string verbatim (webhook_entity.webhookPath), but it matches an
// inbound request against the path Express has already decoded. Any node name
// that needed escaping — the default `Rendobar Trigger` has a space — is
// registered at an address that answers 404 forever. The node re-encodes each
// segment so n8n's single decode lands back on what it stored.
const { deliverableWebhookUrl } = require('../dist/nodes/RendobarTrigger/RendobarTrigger.node.js');

const N8N_BASE = 'https://n8n.example.com/webhook';

// Mirrors NodeHelpers.getNodeWebhookPath for a node with no `webhookId`, which
// is the branch that embeds the node name.
function n8nStoredPath(workflowId, nodeName, webhookPath) {
	return `${workflowId}/${encodeURIComponent(nodeName.toLowerCase())}/${webhookPath}`;
}

// Mirrors the production route `/webhook/*path`: Express hands the handler the
// wildcard segments already percent-decoded, and n8n joins them and compares
// the result to the stored path with an exact string match.
function n8nMatchedPath(url) {
	return new URL(url).pathname
		.replace(`${new URL(N8N_BASE).pathname}/`, '')
		.split('/')
		.map(decodeURIComponent)
		.join('/');
}

// Node names that survive encodeURIComponent unchanged, so their address is
// already deliverable and must not be touched.
const PLAIN_NAMES = ['RendobarTrigger', 'rendobar', 'rendobar-trigger', 'trigger_1'];

// Node names n8n escapes on the way in, which is what breaks delivery.
const ESCAPED_NAMES = [
	'Rendobar Trigger',
	'Rendobar  Trigger',
	'Job done?',
	'100% done',
	'a+b',
	'render/burn',
	'Rendobar Trigger #2',
	'Auslösen',
];

test('an address n8n can still match is handed to Rendobar unchanged', () => {
	for (const name of PLAIN_NAMES) {
		const url = `${N8N_BASE}/${n8nStoredPath('wf42', name, 'webhook')}`;
		assert.equal(deliverableWebhookUrl(url), url, `${name} needed no re-encoding`);
	}
	// The path n8n builds for a node that does carry a webhookId has no name in
	// it at all, and must come through untouched too.
	const uuidUrl = `${N8N_BASE}/8a51b1d4-9419-4722-8c95-2f61745a0a99/webhook`;
	assert.equal(deliverableWebhookUrl(uuidUrl), uuidUrl);
});

test('a delivery address decodes to exactly the path n8n stored', () => {
	for (const name of [...PLAIN_NAMES, ...ESCAPED_NAMES]) {
		const stored = n8nStoredPath('wf42', name, 'webhook');
		const delivered = deliverableWebhookUrl(`${N8N_BASE}/${stored}`);
		assert.equal(
			n8nMatchedPath(delivered),
			stored,
			`a delivery to ${delivered} would not match the webhook n8n registered for "${name}"`,
		);
	}
});

test('the address n8n reports is the one that misses, which is why it is rewritten', () => {
	// Pins the defect itself: without the rewrite, an escaped name arrives as
	// something n8n never stored, so nothing matches and the delivery 404s.
	for (const name of ESCAPED_NAMES) {
		const stored = n8nStoredPath('wf42', name, 'webhook');
		assert.notEqual(
			n8nMatchedPath(`${N8N_BASE}/${stored}`),
			stored,
			`"${name}" was expected to break n8n's own round trip`,
		);
	}
});

test('only the path is rewritten, and only the segments that need it', () => {
	const delivered = deliverableWebhookUrl(
		'https://n8n.example.com:5678/hooks/wf42/rendobar%20trigger/webhook?x=1#f',
	);
	assert.equal(
		delivered,
		'https://n8n.example.com:5678/hooks/wf42/rendobar%2520trigger/webhook?x=1#f',
	);
});

test('the default node name is one n8n escapes, so the rewrite stays exercised', () => {
	// Renaming the node to something space-free would hide the break rather than
	// fix it — a user can rename a node to anything. Keeping a name n8n has to
	// escape means the round trip above is what the default configuration runs.
	const name = new RendobarTrigger().description.defaults.name;
	assert.notEqual(
		encodeURIComponent(name.toLowerCase()),
		name.toLowerCase(),
		`the default name "${name}" no longer exercises the webhook path rewrite`,
	);
});
