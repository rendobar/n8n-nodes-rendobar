// Resolves every node panel through n8n's own helpers, the same ones the editor
// runs to render a panel and to decide whether to put a red issue badge on the
// node. Unit tests assert what the description says; this asserts what n8n makes
// of it. A malformed `displayOptions`, a collection default n8n cannot resolve,
// or a required field with no reachable value shows up here and nowhere else.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { NodeHelpers } = require('n8n-workflow');

const { Rendobar } = require('../dist/nodes/Rendobar/Rendobar.node.js');
const { RendobarTrigger } = require('../dist/nodes/RendobarTrigger/RendobarTrigger.node.js');

const root = join(__dirname, '..');

const TYPES = {
	'@rendobar/n8n-nodes-rendobar.rendobar': new Rendobar().description,
	'@rendobar/n8n-nodes-rendobar.rendobarTrigger': new RendobarTrigger().description,
};

/** The issues n8n would draw on the node, or null when the panel is clean. */
function panelIssues(node) {
	const description = TYPES[node.type];
	const full = { ...node, parameters: node.parameters ?? {} };

	// Resolving first is what the editor does before it checks for issues, and
	// it throws on a description n8n cannot make sense of.
	NodeHelpers.getNodeParameters(description.properties, full.parameters, true, false, full, description);

	return NodeHelpers.getNodeParametersIssues(description.properties, full, description);
}

function rendobar(parameters) {
	return { name: 'Rendobar', type: '@rendobar/n8n-nodes-rendobar.rendobar', parameters };
}

const PANELS = [
	['Job: Create, fields', { resource: 'job', operation: 'create', jobType: { __rl: true, mode: 'list', value: 'ffmpeg' }, inputsMode: 'fields', paramsMode: 'fields' }],
	['Job: Create, JSON', { resource: 'job', operation: 'create', jobType: { __rl: true, mode: 'id', value: 'ffprobe' }, inputsMode: 'json', inputs: '{}', paramsMode: 'json', paramsJson: '{}' }],
	['Job: Get', { resource: 'job', operation: 'get', jobId: { __rl: true, mode: 'id', value: 'job_abc123' } }],
	['Job: Get, downloading', { resource: 'job', operation: 'get', jobId: { __rl: true, mode: 'id', value: 'job_abc123' }, downloadOutput: true, outputBinaryProperty: 'data' }],
	['Job: Get Many', { resource: 'job', operation: 'getAll', returnAll: false, limit: 50 }],
	['Job: Get Many, all', { resource: 'job', operation: 'getAll', returnAll: true }],
	['Job: Cancel', { resource: 'job', operation: 'cancel', jobId: { __rl: true, mode: 'url', value: 'https://app.rendobar.com/jobs/job_abc123' } }],
	['Job: Download Output', { resource: 'job', operation: 'download', jobId: { __rl: true, mode: 'id', value: 'job_abc123' }, downloadBinaryProperty: 'data' }],
	['Job: Get Logs', { resource: 'job', operation: 'getLogs', jobId: { __rl: true, mode: 'id', value: 'job_abc123' } }],
	['File: Upload', { resource: 'file', operation: 'upload', binaryProperty: 'data' }],
	['Account: Get', { resource: 'account', operation: 'getAccount' }],
];

for (const [label, parameters] of PANELS) {
	test(`n8n draws no issues on the ${label} panel`, () => {
		assert.equal(panelIssues(rendobar(parameters)), null);
	});
}

test('n8n draws no issues on the trigger panel', () => {
	const node = {
		name: 'Rendobar Trigger',
		type: '@rendobar/n8n-nodes-rendobar.rendobarTrigger',
		parameters: { events: ['job.completed', 'job.failed'] },
	};
	assert.equal(panelIssues(node), null);
});

test('a workflow saved before the Options collection still opens clean', () => {
	// 0.5.0 moved six Create parameters into Options. n8n resolves a panel
	// against the SAVED values, so a workflow from 0.4.0 carries them at the top
	// level where the description no longer declares them. That must not read as
	// a broken node. `test/back-compat.test.js` covers the execution half.
	const node = rendobar({
		resource: 'job',
		operation: 'create',
		jobType: { __rl: true, mode: 'id', value: 'ffprobe' },
		inputsMode: 'json',
		inputs: '{"source":"https://cdn.rendobar.com/assets/examples/sample.mp4"}',
		paramsMode: 'json',
		paramsJson: '{"command":"-i {source}"}',
		waitForCompletion: true,
		pollInterval: 5,
		maxWait: 300,
		idempotencyKey: 'order-4417',
	});
	assert.equal(panelIssues(node), null);
});

test('every node in the README example workflows opens clean', () => {
	// A reviewer imports these. One that lands with an issue badge reads as a
	// broken node before they have configured anything.
	const readme = readFileSync(join(root, 'README.md'), 'utf8');
	const workflows = [...readme.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((match) =>
		JSON.parse(match[1]),
	);

	let checked = 0;
	for (const workflow of workflows) {
		for (const node of workflow.nodes) {
			if (TYPES[node.type] === undefined) continue;
			assert.equal(panelIssues(node), null, `${node.name} opens with issues`);
			checked += 1;
		}
	}
	assert.ok(checked >= 5, `only ${checked} example nodes were checked`);
});
