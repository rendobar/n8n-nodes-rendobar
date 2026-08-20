// Pins the two operations added in 0.4.0 whose behaviour lives outside the node
// description: what Download Output does when there is nothing to download, and
// what Get Logs does when the API has no logs to give.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
	headlineOutputFile,
	noOutputFile,
	readJobLogs,
} = require('../dist/nodes/Rendobar/Rendobar.node.js');
const { describeFailure } = require('../dist/nodes/Rendobar/shared/failure.js');

const NODE = { id: 'node_a', name: 'Rendobar', type: 'rendobar', typeVersion: 1, position: [0, 0] };

// Same word list the failure tests use: the n8n guidelines ban these from both
// halves of a stop.
const BANNED_WORDS = /\b(error|errors|problem|problems|failure|failures|mistake|mistakes|failed)\b/i;

/**
 * An IExecuteFunctions stand-in carrying only what the transport touches, plus
 * the paths the node actually asked for.
 */
function fakeContext(responses) {
	const paths = [];
	return {
		paths,
		getNode: () => NODE,
		getCredentials: async () => ({ baseUrl: 'https://api.example.com' }),
		helpers: {
			httpRequestWithAuthentication: async (_credentialType, options) => {
				paths.push(options.url);
				const next = responses.shift();
				if (next === undefined) throw new Error('the node made an unexpected extra request');
				return { statusCode: next.statusCode, headers: {}, body: next.body };
			},
		},
	};
}

const FILE = { url: 'https://cdn.example.com/out.mp4?token=x', path: 'output.mp4', type: 'video' };

test('the headline output file is found only where the API actually put one', () => {
	assert.deepEqual(
		headlineOutputFile({ id: 'job_a', status: 'complete', output: { file: FILE, files: [FILE] } }),
		FILE,
	);

	// A data-only job completes with `file: null`, which is the whole reason
	// Download Output cannot simply assume there is something to fetch.
	assert.equal(
		headlineOutputFile({ id: 'job_a', status: 'complete', output: { data: { streams: [] }, file: null } }),
		undefined,
	);
	// A job that has not finished carries no `output` at all.
	assert.equal(headlineOutputFile({ id: 'job_a', status: 'running' }), undefined);
	assert.equal(headlineOutputFile({}), undefined);
	// A file entry with no link is no more downloadable than no file entry.
	assert.equal(headlineOutputFile({ output: { file: { path: 'output.mp4' } } }), undefined);
});

test('Download Output on a job with no file names the job and stays inside the copy rules', () => {
	const details = describeFailure(
		noOutputFile(NODE, { id: 'job_abc123', status: 'complete' }, 'job_abc123', 0),
	);

	assert.match(details.message, /job_abc123/);
	assert.equal(details.code, 'NO_OUTPUT_FILE');
	assert.equal(details.jobId, 'job_abc123');
	// The marker n8n's guidelines ask for, so the panel says which item stopped.
	assert.match(details.message, /\[item 0\]$/);

	for (const [what, copy] of [
		['message', details.message],
		['description', details.description],
	]) {
		const hit = BANNED_WORDS.exec(copy);
		assert.equal(hit, null, `${what} uses the banned word "${hit?.[0]}": ${copy}`);
	}
	// Naming the alternative is the point of the description: a data-only job
	// has its result somewhere else.
	assert.match(details.description, /'data'/);
});

test('whether a missing output file is worth retrying follows the job, not the operation', () => {
	// A job still on its way to a result may well have a file on the next pass.
	for (const status of ['waiting', 'dispatched', 'running']) {
		assert.equal(
			describeFailure(noOutputFile(NODE, { status }, 'job_a', 0)).retryable,
			true,
			`${status} should be worth another pass`,
		);
	}
	// A job that has settled will not grow one, however many times it is asked.
	for (const status of ['complete', 'failed', 'cancelled']) {
		assert.equal(
			describeFailure(noOutputFile(NODE, { status }, 'job_a', 0)).retryable,
			false,
			`${status} is settled`,
		);
	}
});

test('Get Logs returns what the API sent', async () => {
	const entries = [
		{ timestamp: 1787191408330, level: 'info', event: 'job.start', message: 'Starting job' },
		{
			timestamp: 1787191408761,
			level: 'info',
			step: 'execute-ffprobe',
			event: 'step.complete',
			message: 'Step: execute-ffprobe completed',
			durationMs: 329,
		},
	];
	const ctx = fakeContext([{ statusCode: 200, body: { data: entries } }]);

	assert.deepEqual(await readJobLogs.call(ctx, 'job_abc123', 0), entries);
	assert.deepEqual(ctx.paths, ['https://api.example.com/jobs/job_abc123/logs']);
});

test('a job with no logs hands back an empty list rather than stopping the workflow', async () => {
	// `GET /jobs/:id/logs` answers 404 for a job that never reached a runner and
	// for one whose logs the retention sweep has removed. Reacting to job.failed
	// and asking for the logs is the case this operation exists for, and a job
	// that stopped before a runner saw it is exactly the job that has none. A
	// stop there would end the workflow at the point someone is trying to find
	// out what happened.
	const ctx = fakeContext([
		{ statusCode: 404, body: { error: { code: 'NOT_FOUND', message: 'No logs available.' } } },
	]);

	assert.deepEqual(await readJobLogs.call(ctx, 'job_abc123', 0), []);
});

test('anything other than a 404 is still reported', async () => {
	// An empty list has to mean "there are none", so a stall or a revoked key
	// must not quietly read as one. The caller has already read the job, so a
	// 404 naming the job itself cannot arrive here.
	const ctx = fakeContext([
		{ statusCode: 403, body: { error: { code: 'FORBIDDEN', message: 'Not allowed' } } },
	]);

	await assert.rejects(readJobLogs.call(ctx, 'job_abc123', 0), (raised) => {
		const details = describeFailure(raised);
		assert.equal(details.code, 'FORBIDDEN');
		assert.equal(details.jobId, 'job_abc123');
		assert.equal(details.retryable, false);
		return true;
	});
});

test('a malformed logs response reads as no logs rather than as data', async () => {
	for (const body of [{}, { data: null }, { data: 'nope' }, null]) {
		const ctx = fakeContext([{ statusCode: 200, body }]);
		assert.deepEqual(await readJobLogs.call(ctx, 'job_a', 0), []);
	}
});
