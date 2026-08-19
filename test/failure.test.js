// Pins the structured failure contract: the fields a workflow branches on, and
// the copy rules n8n's UX guidelines put on messages and descriptions.
// https://docs.n8n.io/connect/create-nodes/build-your-node/reference/ux-guidelines/
const test = require('node:test');
const assert = require('node:assert/strict');

const {
	describeApiCode,
	describeFailure,
	failureFromJob,
	failureFromResponse,
	failureItemJson,
	rememberFailure,
	withItemMarker,
} = require('../dist/nodes/Rendobar/shared/failure.js');

// The n8n guidelines ban these from both halves of an error. They are matched
// as whole words so a machine code like RUNNER_ERROR, which is data rather than
// copy, is not caught.
const BANNED_WORDS = /\b(error|errors|problem|problems|failure|failures|mistake|mistakes|failed)\b/i;

function assertCleanCopy(text, what) {
	assert.ok(typeof text === 'string' && text.length > 0, `${what} is empty`);
	const hit = BANNED_WORDS.exec(text);
	assert.equal(hit, null, `${what} uses the banned word "${hit?.[0]}": ${text}`);
}

test('an API response becomes branchable details', () => {
	const details = failureFromResponse(402, {
		error: { code: 'INSUFFICIENT_CREDITS', message: 'Balance too low to run this job' },
	});

	assert.equal(details.code, 'INSUFFICIENT_CREDITS');
	assert.equal(details.message, 'Balance too low to run this job');
	assert.equal(details.httpStatus, 402);
	assert.equal(details.retryable, false);
	assert.match(details.description, /dashboard/);
});

test('a throttled or stalled response is marked retryable, a rejected one is not', () => {
	for (const status of [429, 500, 502, 503, 504]) {
		assert.equal(failureFromResponse(status, null).retryable, true, `${status} should retry`);
	}
	for (const status of [400, 401, 403, 404, 409, 413, 422]) {
		assert.equal(failureFromResponse(status, null).retryable, false, `${status} should not retry`);
	}
});

test('a body that is not the Rendobar envelope still yields usable details', () => {
	const details = failureFromResponse(502, '<html>Bad gateway</html>');
	assert.equal(details.code, 'HTTP_502');
	assert.equal(details.httpStatus, 502);
	assert.equal(details.retryable, true);
	assert.ok(details.message.includes('502'));
});

test('a stopped job carries its code, phase and retryability', () => {
	const details = failureFromJob(
		{
			id: 'job_abc123',
			status: 'failed',
			error: {
				code: 'RUNNER_TIMEOUT',
				message: 'Runner exceeded its time budget',
				detail: 'ffmpeg: killed after 3600s',
				retryable: true,
				failedPhase: 'processing',
			},
		},
		'job_abc123',
	);

	assert.equal(details.code, 'RUNNER_TIMEOUT');
	assert.equal(details.retryable, true);
	assert.equal(details.failedPhase, 'processing');
	assert.equal(details.jobId, 'job_abc123');
	assert.ok(details.message.includes('job_abc123'));
	// The runner's own output belongs in the description, not the headline.
	assert.ok(details.description.includes('ffmpeg: killed after 3600s'));
	assert.ok(!details.message.includes('ffmpeg'));
});

test("Rendobar's generic placeholder is not repeated into the headline", () => {
	const details = failureFromJob(
		{ id: 'job_x', status: 'failed', error: { code: 'JOB_FAILED', message: 'Job failed' } },
		'job_x',
	);
	assertCleanCopy(details.message, 'job failure message');
	assert.ok(details.message.includes('job_x'));
});

test('a stopped job with no retryable flag falls back to the code', () => {
	assert.equal(
		failureFromJob({ error: { code: 'RUNNER_ERROR' } }, 'job_x').retryable,
		true,
	);
	assert.equal(
		failureFromJob({ error: { code: 'EXECUTION_ERROR' } }, 'job_x').retryable,
		false,
	);
	// An explicit flag from the API always wins over the fallback.
	assert.equal(
		failureFromJob({ error: { code: 'RUNNER_ERROR', retryable: false } }, 'job_x').retryable,
		false,
	);
});

test('the Continue On Fail item keeps n8n\'s string field and adds routable siblings', () => {
	const json = failureItemJson(
		failureFromJob(
			{ error: { code: 'PROCESSING_FAILED', message: 'No audio stream', failedPhase: 'preparing' } },
			'job_abc123',
		),
	);

	assert.equal(typeof json.error, 'string', 'n8n expects `error` to be the message string');
	assert.equal(json.code, 'PROCESSING_FAILED');
	assert.equal(json.retryable, false);
	assert.equal(json.failedPhase, 'preparing');
	assert.equal(json.jobId, 'job_abc123');
});

test('the Continue On Fail item omits fields the situation does not have', () => {
	const json = failureItemJson({ message: 'Something stopped', code: 'NODE_ERROR', retryable: false });
	assert.deepEqual(Object.keys(json).sort(), ['code', 'error', 'retryable']);
});

test('remembered details survive the throw and are recovered in the catch', () => {
	const error = rememberFailure(new Error('boom'), {
		message: 'Rendobar stopped job job_x',
		code: 'RUNNER_ERROR',
		retryable: true,
		jobId: 'job_x',
	});

	const details = describeFailure(error);
	assert.equal(details.code, 'RUNNER_ERROR');
	assert.equal(details.retryable, true);
	assert.equal(details.jobId, 'job_x');
});

test('an unremembered error still produces the same shape', () => {
	const details = describeFailure(new Error('Cannot read properties of undefined'));
	assert.equal(details.code, 'NODE_ERROR');
	assert.equal(details.retryable, false);
	assert.equal(details.message, 'Cannot read properties of undefined');

	const thrown = describeFailure('a bare string');
	assert.equal(thrown.code, 'NODE_ERROR');
	assert.equal(thrown.message, 'a bare string');
});

test('the item marker n8n asks for is appended to the message', () => {
	assert.equal(withItemMarker('Job job_x is still running', 2), 'Job job_x is still running [item 2]');
});

test('every guidance line avoids the words the guidelines ban', () => {
	// Walks the codes the API can send, so a new entry cannot slip a banned word
	// past review.
	const codes = [
		'UNAUTHORIZED',
		'FORBIDDEN',
		'ORG_SUSPENDED',
		'PLAN_LIMIT',
		'INSUFFICIENT_CREDITS',
		'STORAGE_QUOTA_EXCEEDED',
		'FILE_TOO_LARGE',
		'RATE_LIMITED',
		'QUEUE_FULL',
		'NOT_FOUND',
		'GONE',
		'CONFLICT',
		'VALIDATION_ERROR',
		'INVALID_JOB_TYPE',
		'INPUT_URL_BLOCKED',
		'INPUT_FETCH_FAILED',
		'INPUT_NOT_MEDIA',
		'INPUT_UNSUPPORTED',
		'PROCESSING_FAILED',
		'RUNNER_ERROR',
		'RUNNER_TIMEOUT',
		'UPSTREAM_ERROR',
		'INTERNAL_ERROR',
		'NOT_CONFIGURED',
		'NOT_IMPLEMENTED',
	];

	for (const code of codes) {
		const description = describeApiCode(code);
		assert.ok(description, `${code} has no guidance line`);
		assertCleanCopy(description, `guidance for ${code}`);
	}

	// And the fallback used for a code with no entry of its own.
	assertCleanCopy(failureFromResponse(418, null).description, 'the generic guidance line');
});

test('guidance lines quote parameter names the way the guidelines require', () => {
	// Where a line names a node parameter it must wrap it in single quotes.
	for (const code of ['VALIDATION_ERROR', 'INVALID_JOB_TYPE', 'INPUT_FETCH_FAILED', 'NOT_FOUND']) {
		const description = describeApiCode(code);
		assert.match(description, /'[A-Z][^']*'/, `${code} names a parameter without quoting it`);
	}
});
