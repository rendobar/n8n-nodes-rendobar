// The workflow templates under templates/ are what n8n's template reviewers
// import and what a user pastes into their editor. This pins what the Creator
// Hub guidelines ask for and what the editor would refuse, so a template that
// drifts fails the build instead of a review round.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { NodeHelpers } = require('n8n-workflow');

const { Rendobar } = require('../dist/nodes/Rendobar/Rendobar.node.js');
const { RendobarTrigger } = require('../dist/nodes/RendobarTrigger/RendobarTrigger.node.js');

const root = join(__dirname, '..');
const dir = join(root, 'templates');

const OUR_TYPES = {
	'@rendobar/n8n-nodes-rendobar.rendobar': new Rendobar().description,
	'@rendobar/n8n-nodes-rendobar.rendobarTrigger': new RendobarTrigger().description,
};

const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const templates = files.map((f) => ({ file: f, workflow: JSON.parse(readFileSync(join(dir, f), 'utf8')) }));

const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;

test('there are templates to check', () => {
	assert.ok(templates.length >= 3, `expected at least three templates, found ${templates.length}`);
});

for (const { file, workflow } of templates) {
	const nodes = workflow.nodes;
	const stickies = nodes.filter((n) => n.type === 'n8n-nodes-base.stickyNote');
	const real = nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote');
	const ours = real.filter((n) => n.type in OUR_TYPES);

	test(`${file}: title reads like an n8n template`, () => {
		assert.ok(workflow.name.length <= 80, `title is ${workflow.name.length} chars, the Creator Hub caps it at 80`);
		assert.match(workflow.name, /^[A-Z][a-z]/, 'title opens with a capitalised word in sentence case');
		assert.ok(workflow.name.includes('Rendobar'), 'title names the node');
		assert.ok(!/[—–;]/.test(workflow.name), 'no em-dash, en-dash or semicolon in the title');
	});

	test(`${file}: carries the main sticky note the reviewers look for`, () => {
		const main = stickies.find((s) => !s.parameters.color);
		assert.ok(main, 'one yellow (default colour) sticky note');
		const body = main.parameters.content;
		assert.ok(body.includes('## How it works'), 'main sticky has a "How it works" section');
		assert.ok(body.includes('## Setup steps'), 'main sticky has a "Setup steps" section');
		const n = words(body);
		assert.ok(n >= 100 && n <= 300, `main sticky is ${n} words, the guideline is 100 to 300`);
		for (const s of stickies.filter((x) => x.parameters.color === 7)) {
			const w = words(s.parameters.content);
			assert.ok(w < 50, `section sticky "${s.name}" is ${w} words, the guideline is under 50`);
		}
	});

	test(`${file}: uses the Rendobar node itself, not an HTTP Request`, () => {
		assert.ok(ours.length >= 2, 'at least two Rendobar nodes, so the template counts on the integration page');
		assert.ok(!real.some((n) => n.type === 'n8n-nodes-base.httpRequest' && JSON.stringify(n.parameters).includes('rendobar.com')),
			'no HTTP Request to api.rendobar.com');
	});

	test(`${file}: n8n draws no issues on any Rendobar node`, () => {
		for (const node of ours) {
			const description = OUR_TYPES[node.type];
			const full = { ...node, parameters: node.parameters ?? {} };
			NodeHelpers.getNodeParameters(description.properties, full.parameters, true, false, full, description);
			assert.equal(
				NodeHelpers.getNodeParametersIssues(description.properties, full, description),
				null,
				`${node.name} has parameter issues`,
			);
		}
	});

	test(`${file}: every node is ours or n8n's own`, () => {
		for (const n of real) {
			assert.ok(n.type in OUR_TYPES || n.type.startsWith('n8n-nodes-base.'), `${n.name} is ${n.type}`);
			assert.equal(typeof n.typeVersion, 'number', `${n.name} pins a typeVersion`);
			assert.ok(Array.isArray(n.position) && n.position.length === 2, `${n.name} has a position`);
		}
	});

	test(`${file}: connections only name nodes that exist`, () => {
		const names = new Set(nodes.map((n) => n.name));
		for (const [from, outs] of Object.entries(workflow.connections)) {
			assert.ok(names.has(from), `connection from unknown node "${from}"`);
			for (const branch of outs.main) for (const c of branch) {
				assert.ok(names.has(c.node), `connection to unknown node "${c.node}"`);
			}
		}
		const targets = new Set(Object.values(workflow.connections).flatMap((o) => o.main.flat().map((c) => c.node)));
		const sources = new Set(Object.keys(workflow.connections));
		for (const n of real) {
			const isTrigger = n.type.includes('Trigger') || n.type.endsWith('.formTrigger');
			assert.ok(isTrigger || targets.has(n.name), `${n.name} has no incoming connection`);
			assert.ok(!isTrigger || sources.has(n.name), `${n.name} triggers nothing`);
		}
	});

	test(`${file}: ships no credentials and no live secrets`, () => {
		for (const n of nodes) assert.equal(n.credentials, undefined, `${n.name} carries a credentials block`);
		const text = JSON.stringify(workflow);
		assert.ok(!/rb_(live|test)_[A-Za-z0-9]/.test(text), 'an API key is embedded');
		assert.ok(!text.includes('—'), 'an em-dash is embedded');
	});

	test(`${file}: a long job parks on a Wait node instead of polling`, () => {
		const creates = ours.filter((n) => n.parameters.resource === 'job' && n.parameters.operation === 'create');
		for (const c of creates) {
			assert.equal(c.parameters.options?.callbackUrl, '={{ $execution.resumeUrl }}', `${c.name} hands the Wait node's resume URL to the job`);
			assert.notEqual(c.parameters.options?.waitForCompletion, true, `${c.name} must not also wait for completion`);
		}
		const wait = real.find((n) => n.type === 'n8n-nodes-base.wait');
		assert.ok(wait, 'a Wait node');
		assert.equal(wait.parameters.resume, 'webhook');
		assert.equal(wait.parameters.httpMethod, 'POST', 'Rendobar POSTs the callback, and the Wait node defaults to GET');
		assert.equal(wait.parameters.limitWaitTime, true, 'a callback that never lands must release the execution');
	});
}

test('the README points at the templates', () => {
	const readme = readFileSync(join(root, 'README.md'), 'utf8');
	assert.ok(readme.includes('templates/'), 'README links the templates folder');
});
