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

test('the trigger deliberately does not advertise itself as an AI tool', () => {
	// A trigger cannot be invoked by an agent, and n8n's type only allows `true`,
	// so the only way to say no is to leave the flag off.
	assert.equal(new RendobarTrigger().description.usableAsTool, undefined);
});
