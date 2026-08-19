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

test('a code that no retry can clear is not reported as retryable', () => {
	// NOT_CONFIGURED answers 503, which is in the retryable status set, but it
	// means a capability is switched off for the account. Reporting it as
	// retryable contradicts its own guidance and loops a workflow forever.
	const details = failureFromResponse(503, { error: { code: 'NOT_CONFIGURED', message: 'off' } });
	assert.equal(details.retryable, false);
	assert.match(details.description, /Contact Rendobar support/);

	// A plain 503 with no such code is still retryable.
	assert.equal(failureFromResponse(503, null).retryable, true);
	assert.equal(
		failureFromResponse(501, { error: { code: 'NOT_IMPLEMENTED', message: 'no' } }).retryable,
		false,
	);
});

test('the fallback set matches every code the API calls retryable', () => {
	// Mirrors RETRYABLE_ERROR_CODES in the API's lib/job-utils.ts. Each of these
	// describes a job that never reached a runner, so a retry costs nothing. A
	// code missing from here is reported as terminal to a workflow that routes
	// on `retryable`, which is how the whole dispatch family was misclassified
	// once already.
	for (const code of [
		'DISPATCH_EXHAUSTED',
		'DISPATCH_UNAVAILABLE',
		'PROVIDER_CLEARED',
		'P1_EXECUTION_ERROR',
		'RUNNER_TIMEOUT',
		'RUNNER_ERROR',
		// The retired name for the dispatch family. Nothing writes it now, but a
		// job old enough to carry it has to classify the same way.
		'DISPATCH_ERROR',
	]) {
		assert.equal(failureFromJob({ error: { code } }, 'job_x').retryable, true, code);
	}

	for (const code of ['PROCESSING_FAILED', 'VALIDATION_ERROR', 'INPUT_FETCH_FAILED']) {
		assert.equal(failureFromJob({ error: { code } }, 'job_x').retryable, false, code);
	}
});

test('a crashed provider run is never reported as retryable by the fallback', () => {
	// PROVIDER_CRASHED is deliberately outside the API's retryable set: the run
	// started, so it is billed. A workflow that routes `retryable` into a retry
	// would resubmit an unchanged input to an unchanged model, crash the same
	// way, and pay again.
	assert.equal(failureFromJob({ error: { code: 'PROVIDER_CRASHED' } }, 'job_x').retryable, false);
});

test('the fallback never overrides what the API said', () => {
	// The API sends `retryable` on the job and is the authority on its own codes.
	// The set here only fills in for a job that arrives without the flag, so a
	// code Rendobar reclassifies takes effect without this node being republished.
	assert.equal(
		failureFromJob({ error: { code: 'DISPATCH_EXHAUSTED', retryable: false } }, 'job_x').retryable,
		false,
		'an explicit false must win over the retryable fallback',
	);
	assert.equal(
		failureFromJob({ error: { code: 'PROVIDER_CRASHED', retryable: true } }, 'job_x').retryable,
		true,
		'an explicit true must win over the absence from the fallback',
	);
});

test('a job that never ran is not told to go and read what the runner reported', () => {
	// Advice that contradicts `retryable` beside it is the NOT_CONFIGURED bug in
	// reverse: these codes mean no runner ever saw the job, so PROCESSING_FAILED's
	// "open the job and adjust your parameters" is the wrong thing to say.
	for (const code of [
		'DISPATCH_EXHAUSTED',
		'DISPATCH_UNAVAILABLE',
		'DISPATCH_ERROR',
		'PROVIDER_CLEARED',
		'P1_EXECUTION_ERROR',
	]) {
		const details = failureFromJob({ error: { code } }, 'job_x');
		assert.equal(details.retryable, true, code);
		assert.notEqual(details.description, describeApiCode('PROCESSING_FAILED'), code);
		assert.match(details.description, /Run the workflow again/, code);
		assertCleanCopy(details.description, `guidance for ${code}`);
	}
});

test('every code the API can send has guidance that fits it', () => {
	// CONFLICT is not job-only: the trigger hits it when the account is already
	// at its webhook endpoint limit, so the copy must not assume a job.
	const conflict = describeApiCode('CONFLICT');
	assert.ok(!/^The job /.test(conflict), 'CONFLICT copy assumes a job');

	for (const code of ['QUEUE_EXPIRED', 'HTTP_ERROR']) {
		assert.ok(describeApiCode(code), `${code} has no guidance line`);
		assertCleanCopy(describeApiCode(code), `guidance for ${code}`);
	}
});

test('an empty httpCode is not read as the status zero', () => {
	// Number('') is 0 and 0 is finite, so this used to surface as HTTP_0.
	const { NodeApiError } = require('n8n-workflow');
	const node = { id: 'n1', name: 'Rendobar', type: 'rendobar', typeVersion: 1, position: [0, 0] };
	const details = describeFailure(new NodeApiError(node, { message: 'socket hang up' }));

	assert.notEqual(details.code, 'HTTP_0');
	assert.equal(details.httpStatus, undefined);
});

test('a spent idempotency key says which job holds it and which parameter moves it', () => {
	// `POST /jobs` answers this once the key it was handed belongs to a job that
	// stopped without reaching a runner. Rendobar's own message ends "Retry with
	// a new idempotency key", which is right for a client that mints its own and
	// useless to a workflow builder who has never seen one: this node generates
	// it. So the node writes the headline, and it has to carry three things —
	// which job the key went to, that the job produced nothing, and what to do.
	const details = failureFromResponse(409, {
		error: {
			code: 'CONFLICT',
			message:
				'Idempotency key "n8n:1:a:0:0:x" is already bound to job job_abc123, which failed with a retryable error. Reusing the key cannot create a new job. Retry with a new idempotency key.',
			details: { jobId: 'job_abc123' },
		},
	});

	assert.equal(details.code, 'CONFLICT');
	assert.equal(details.httpStatus, 409);
	assert.equal(details.jobId, 'job_abc123', 'the bound job has to reach the output item');
	assert.ok(details.message.includes('job_abc123'), 'the headline must name the bound job');
	assert.match(details.message, /already taken/, 'the headline must say the key is spent');
	assert.match(details.message, /stopped before it produced a result/);
	// The way out has to be a lever that exists in the n8n UI.
	assert.match(details.description, /'Idempotency Key'/);
	assertCleanCopy(details.message, 'spent key message');
	assertCleanCopy(details.description, 'spent key guidance');

	// Not retryable: repeating the identical call reproduces this answer for as
	// long as the key stays the same, so a workflow routing on `retryable` must
	// not loop on it.
	assert.equal(details.retryable, false);
});

test('a conflict with no job attached keeps the general guidance', () => {
	// The trigger hits 409 when the account is at its webhook endpoint limit, and
	// Cancel hits it on a job that has already settled. Neither is a spent key,
	// and neither sends `details.jobId`.
	const details = failureFromResponse(409, {
		error: { code: 'CONFLICT', message: 'Job is already cancelled' },
	});

	assert.equal(details.message, 'Job is already cancelled', "Rendobar's own words are kept");
	assert.equal(details.description, describeApiCode('CONFLICT'));
	assert.equal(details.jobId, undefined);
});

test('a job ID the caller already knows outranks the one on the body', () => {
	// waitForJob knows which job it was polling; the body only ever names the job
	// a spent key went to.
	const details = failureFromResponse(
		409,
		{ error: { code: 'CONFLICT', details: { jobId: 'job_bound' } } },
		'job_polled',
	);
	assert.equal(details.jobId, 'job_polled');
});
