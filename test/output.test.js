// Unit tests for the pure helpers the node compiles to dist/. Run against the
// build output (`npm run build` first) so the tests exercise exactly what n8n
// loads, with no extra toolchain: node:test is built in.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
	SIMPLIFIED_FIELDS,
	SIMPLIFIED_FIELD_LIMIT,
	SIMPLIFIED_ASSET_FIELDS,
	ASSET_FIELDS,
	JOB_FIELDS,
	buildAssetJson,
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
	cost: { amount: 1200, currency: 'USD', formatted: '$0.0012' },
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

const failedJob = {
	id: 'job_failed',
	orgId: 'org_1',
	type: 'ffmpeg',
	status: 'failed',
	cost: { amount: 0, currency: 'USD', formatted: '$0.00' },
	createdAt: 1,
	completedAt: 4,
	region: 'auto',
	webUrl: 'https://app.rendobar.com/jobs/job_failed',
	error: {
		code: 'PROCESSING_FAILED',
		message: 'No audio stream in the input',
		detail: 'ffmpeg: Stream map "0:a" matches no streams',
		retryable: false,
		failedPhase: 'preparing',
	},
};

const runningJob = { id: 'job_running', type: 'ffmpeg', status: 'running', progress: 0.5 };
const waitingJob = { id: 'job_waiting', type: 'ffmpeg', status: 'waiting', createdAt: 1 };
const cancelledJob = { id: 'job_cancelled', type: 'ffmpeg', status: 'cancelled', createdAt: 1, completedAt: 3 };

test("no job status produces a simplified item above n8n's ten-field ceiling", () => {
	// The field list is longer than ten on purpose: Rendobar's job response is a
	// discriminated union, so the output fields and `error` are mutually
	// exclusive. What has to stay within ten is the item, and that is what this
	// walks — every status the API can return.
	for (const job of [completedJob, failedJob, runningJob, waitingJob, cancelledJob]) {
		const json = buildJobJson(job, 'simplified');
		assert.ok(
			Object.keys(json).length <= SIMPLIFIED_FIELD_LIMIT,
			`${job.status} produced ${Object.keys(json).length} fields: ${Object.keys(json).join(', ')}`,
		);
	}
});

test('a complete job and a stopped job never carry each other\'s fields', () => {
	const complete = buildJobJson(completedJob, 'simplified');
	const stopped = buildJobJson(failedJob, 'simplified');

	assert.ok('file' in complete && !('error' in complete));
	assert.ok('error' in stopped && !('file' in stopped));
});

test('simplified output drops the raw job fields and keeps the useful ones', () => {
	const json = buildJobJson(completedJob, 'simplified');
	assert.equal(json.id, 'job_abc123');
	assert.equal(json.status, 'complete');
	assert.equal(json.file.url, 'https://cdn.example/out.mp4');
	assert.equal(json.expiresAt, 99);
	assert.equal(json.orgId, undefined);
	assert.equal(json.region, undefined);
	assert.equal(json.webUrl, undefined);
});

test('simplified output keeps why a job stopped, so a workflow can branch on it', () => {
	// Without `error` in the projection a stopped job arrives as a bare
	// `status: "failed"` with nothing to route on.
	const json = buildJobJson(failedJob, 'simplified');
	assert.equal(json.error.code, 'PROCESSING_FAILED');
	assert.equal(json.error.retryable, false);
	assert.equal(json.error.failedPhase, 'preparing');
});

test('simplified output does not invent fields a running job never had', () => {
	const json = buildJobJson(runningJob, 'simplified');
	assert.deepEqual(Object.keys(json).sort(), ['id', 'status', 'type']);
	assert.ok(!('file' in json));
	assert.ok(!('completedAt' in json));
	assert.ok(!('error' in json));
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

test('selected output keeps the ID even when nothing is picked', () => {
	// The n8n UX guidelines require the ID in Selected Fields whether or not the
	// user chose it, so an agent can always fetch the rest of the job later.
	assert.deepEqual(Object.keys(buildJobJson(completedJob, 'selected', [])), ['id']);
	assert.deepEqual(Object.keys(buildJobJson(completedJob, 'selected', ['status'])), [
		'id',
		'status',
	]);
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

// The File resource returns an asset record. It carries 21 fields, so the n8n
// guidelines want the same Output treatment the job gets.
const asset = {
	id: 'asset_abc123',
	url: 'https://app.rendobar.com/assets/asset_abc123/content',
	orgId: 'org_1',
	createdBy: 'user_1',
	lifecycle: 'ephemeral',
	status: 'ready',
	source: 'api',
	kind: 'input',
	scope: 'org',
	region: 'auto',
	etag: '"abc"',
	checksum: 'sha256:...',
	declaredSize: 1024,
	sizeBytes: 1024,
	contentType: 'video/mp4',
	mediaType: 'video',
	filename: 'clip.mp4',
	expiresAt: 99,
	metadata: {},
	createdAt: 1,
	updatedAt: 2,
};

test('a simplified asset stays within the ten-field ceiling', () => {
	assert.ok(SIMPLIFIED_ASSET_FIELDS.length <= SIMPLIFIED_FIELD_LIMIT);
	const json = buildAssetJson(asset, 'simplified');
	assert.ok(Object.keys(json).length <= SIMPLIFIED_FIELD_LIMIT);
});

test('a simplified asset keeps the URL a job needs and drops the storage detail', () => {
	const json = buildAssetJson(asset, 'simplified');
	assert.equal(json.url, 'https://app.rendobar.com/assets/asset_abc123/content');
	assert.equal(json.filename, 'clip.mp4');
	assert.equal(json.sizeBytes, 1024);
	// Internal bookkeeping a workflow never acts on.
	for (const hidden of ['orgId', 'createdBy', 'scope', 'kind', 'etag', 'checksum', 'region']) {
		assert.equal(json[hidden], undefined, `${hidden} should not be on a simplified asset`);
	}
});

test('a raw asset keeps everything', () => {
	assert.deepEqual(buildAssetJson(asset, 'raw'), asset);
});

test('a selected asset always includes the file ID', () => {
	assert.deepEqual(Object.keys(buildAssetJson(asset, 'selected', ['url'])), ['id', 'url']);
	assert.deepEqual(Object.keys(buildAssetJson(asset, 'selected', [])), ['id']);
});

test('ASSET_FIELDS is sorted, deduplicated, and covers the simplified set', () => {
	assert.deepEqual([...ASSET_FIELDS], [...new Set(ASSET_FIELDS)].sort());
	for (const field of SIMPLIFIED_ASSET_FIELDS) {
		assert.ok(ASSET_FIELDS.includes(field), `${field} missing from ASSET_FIELDS`);
	}
});
