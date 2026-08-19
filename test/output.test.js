// Unit tests for the pure helpers the node compiles to dist/. Run against the
// build output (`npm run build` first) so the tests exercise exactly what n8n
// loads, with no extra toolchain: node:test is built in.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
	SIMPLIFIED_FIELDS,
	JOB_FIELDS,
	liftJobOutput,
	pickJobFields,
	buildJobJson,
	buildJobItem,
	titleCaseFieldName,
} = require('../dist/nodes/Rendobar/shared/output.js');

const completedJob = {
	id: 'job_abc123',
	orgId: 'org_1',
	type: 'ffmpeg',
	status: 'complete',
	cost: 1200,
	createdAt: 1,
	completedAt: 5,
	region: 'auto',
	webUrl: 'https://app.rendobar.com/jobs/job_abc123',
	output: {
		data: null,
		file: { url: 'https://cdn.example/out.mp4', path: 'out.mp4', type: 'video', size: 10 },
		files: [{ url: 'https://cdn.example/out.mp4', path: 'out.mp4', type: 'video', size: 10 }],
		expiresAt: 99,
	},
};

const runningJob = { id: 'job_running', type: 'ffmpeg', status: 'running', progress: 0.5 };

test("Simplify keeps the item within n8n's ten-field ceiling", () => {
	assert.ok(SIMPLIFIED_FIELDS.length <= 10);
	const json = buildJobJson(completedJob, 'simplified');
	assert.ok(Object.keys(json).length <= 10);
});

test('simplified output drops the raw job fields and keeps the useful ones', () => {
	const json = buildJobJson(completedJob, 'simplified');
	assert.equal(json.id, 'job_abc123');
	assert.equal(json.status, 'complete');
	assert.equal(json.cost, 1200);
	assert.equal(json.file.url, 'https://cdn.example/out.mp4');
	assert.equal(json.expiresAt, 99);
	assert.equal(json.orgId, undefined);
	assert.equal(json.region, undefined);
	assert.equal(json.webUrl, undefined);
});

test('simplified output does not invent fields a running job never had', () => {
	const json = buildJobJson(runningJob, 'simplified');
	assert.deepEqual(Object.keys(json).sort(), ['id', 'status', 'type']);
	assert.ok(!('file' in json));
	assert.ok(!('completedAt' in json));
});

test('raw output keeps every field and still lifts the unified output', () => {
	const json = buildJobJson(completedJob, 'raw');
	assert.equal(json.orgId, 'org_1');
	assert.equal(json.region, 'auto');
	assert.deepEqual(json.files, completedJob.output.files);
	assert.equal(json.data, null);
});

test('selected output always includes the job ID and never duplicates it', () => {
	const json = buildJobJson(completedJob, 'selected', ['id', 'status']);
	assert.deepEqual(Object.keys(json), ['id', 'status']);
});

test('selected output returns only the picked fields', () => {
	const json = buildJobJson(completedJob, 'selected', ['cost', 'webUrl']);
	assert.deepEqual(Object.keys(json), ['id', 'cost', 'webUrl']);
});

test('liftJobOutput leaves a job without output untouched apart from the copy', () => {
	const json = liftJobOutput(runningJob);
	assert.deepEqual(json, runningJob);
	assert.notEqual(json, runningJob);
});

test('pickJobFields skips keys the job does not have', () => {
	assert.deepEqual(pickJobFields({ a: 1 }, ['a', 'b']), { a: 1 });
});

test('buildJobItem sets pairedItem so n8n can trace the item back', () => {
	const item = buildJobItem(completedJob, 3, 'simplified');
	assert.deepEqual(item.pairedItem, { item: 3 });
	assert.equal(item.json.id, 'job_abc123');
});

test('every simplified field is a selectable field', () => {
	for (const field of SIMPLIFIED_FIELDS) {
		assert.ok(JOB_FIELDS.includes(field), `${field} missing from JOB_FIELDS`);
	}
});

test('JOB_FIELDS is sorted and free of duplicates', () => {
	assert.deepEqual([...JOB_FIELDS], [...new Set(JOB_FIELDS)].sort());
});

test('titleCaseFieldName turns camelCase into a readable label', () => {
	assert.equal(titleCaseFieldName('completedAt'), 'Completed At');
	assert.equal(titleCaseFieldName('retentionExpiresAt'), 'Retention Expires At');
	assert.equal(titleCaseFieldName('cost'), 'Cost');
});
