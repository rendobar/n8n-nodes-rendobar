import { NodeApiError, type INode } from 'n8n-workflow';
import { booleanAt, objectAt, readString, stringAt, type JsonObject, type JsonValue } from './json';

// One "what went wrong" shape for the whole node, read by the thrown
// NodeApiError/NodeOperationError and by the item pushed when "Continue On Fail"
// is on. `code`/`retryable`/`failedPhase` exist so an If or Switch node can route
// on them; an opaque string cannot.
//
// Copy rule (n8n UX guidelines): `message` says what happened, `description` says
// how to get unstuck, and neither may use "error", "problem", "failure" or
// "mistake". Text Rendobar returns is passed through as-is, per the same
// guidelines on using the service's own vocabulary.
export interface FailureDetails {
	/** What happened. Sentence case, no trailing period. */
	message: string;
	/** How to get unstuck. */
	description?: string;
	/** Machine-readable code. Rendobar's own code whenever it sent one. */
	code: string;
	/** True when running the same step again may succeed. */
	retryable: boolean;
	/** HTTP status, when the call reached Rendobar. */
	httpStatus?: number;
	/** Which phase a job stopped in: preparing, processing or finalizing. */
	failedPhase?: string;
	/** The job this concerns, when there is one. */
	jobId?: string;
}

// HTTP statuses where repeating the identical request may succeed. Matches the
// Rendobar SDK's own retry set so the two clients agree on what is transient.
export const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

// Job-level codes Rendobar treats as retryable, mirroring RETRYABLE_ERROR_CODES
// in the API's `lib/job-utils.ts`.
//
// ONLY the fallback for a job with no `retryable` flag. The API sends one and is
// the authority on its own codes, so `failureFromJob` reads the flag first and a
// code added Rendobar-side classifies correctly long before this list hears of
// it. Every code here describes a job that never ran, which is what makes the
// retry free:
//   DISPATCH_EXHAUSTED   - the dispatch queue burned all its retries
//   DISPATCH_UNAVAILABLE - a transient dispatch fault hit the attempt ceiling
//   PROVIDER_CLEARED     - the runner was decommissioned mid-flight
//   P1_EXECUTION_ERROR   - an inline job died with the API worker
//   RUNNER_TIMEOUT       - the stuck-job sweep or provider reconciliation
//   RUNNER_ERROR         - no healthy runner had capacity
//   DISPATCH_ERROR       - the retired name for the dispatch family. Nothing
//                          writes it any more; kept so a job old enough to
//                          carry it still classifies the same way.
//
// PROVIDER_CRASHED must stay absent. A crashed run DID run: the API sees
// `timing.started` and debits for the compute burned. Marking it retryable
// invites a workflow to resubmit an unchanged input to an unchanged model,
// crash the same way, and pay twice.
const RETRYABLE_JOB_CODES = new Set([
	'DISPATCH_EXHAUSTED',
	'DISPATCH_UNAVAILABLE',
	'PROVIDER_CLEARED',
	'P1_EXECUTION_ERROR',
	'RUNNER_TIMEOUT',
	'RUNNER_ERROR',
	'DISPATCH_ERROR',
]);

// Codes whose HTTP status suggests a retry but whose cause cannot clear on one.
// `NOT_CONFIGURED` answers 503 but means a capability is off for the account, so
// retrying forever contradicts the guidance shown beside it.
const NEVER_RETRYABLE_CODES = new Set(['NOT_CONFIGURED', 'NOT_IMPLEMENTED']);

const GENERIC_DESCRIPTION =
	'Check the values in this node against the Rendobar dashboard, then run the workflow again.';

const TRANSIENT_DESCRIPTION =
	'This is usually temporary and the node already retried. Run the workflow again in a moment. If it keeps happening, contact Rendobar support with the job ID.';

// For the RETRYABLE_JOB_CODES that never reached a runner. Without their own
// line they fall through to PROCESSING_FAILED, which tells the user to read what
// the runner reported for a job no runner ever saw.
//
// Says nothing about the bill: whether a job settles free is decided by the API
// from `startedAt`, not from the code.
const NEVER_RAN_DESCRIPTION =
	'Rendobar could not get this job onto a runner, so there is nothing in this node to change. Run the workflow again in a moment; a new execution submits it afresh rather than handing back this one.';

// "How to solve it", keyed by the code Rendobar returns. Only codes a workflow
// builder can act on are listed; anything else falls back to the generic line.
const DESCRIPTIONS: Record<string, string> = {
	UNAUTHORIZED:
		"Open this node's Rendobar credential and confirm the API key is the full key from the dashboard and has not been revoked.",
	FORBIDDEN:
		'This API key is not allowed to do that. Check the key and the account status in the Rendobar dashboard.',
	ORG_SUSPENDED:
		'The Rendobar account is suspended. Settle the balance in the dashboard, then run the workflow again.',
	PLAN_LIMIT:
		'This is above what the current Rendobar plan allows. Review the plan limits in the dashboard, or upgrade, then run the workflow again.',
	INSUFFICIENT_CREDITS: 'Add credit in the Rendobar dashboard, then run the workflow again.',
	STORAGE_QUOTA_EXCEEDED:
		'Free up storage or raise the quota in the Rendobar dashboard, then run the workflow again.',
	FILE_TOO_LARGE:
		'The file is larger than this plan accepts. Shrink it, or upgrade the plan in the Rendobar dashboard, then run the workflow again.',
	RATE_LIMITED:
		'Rendobar is throttling this account and the node already retried. Lower the batch size, put a Wait node between submissions, or upgrade the plan.',
	QUEUE_FULL:
		'Too many jobs are already queued on this account. Let some finish, then run the workflow again.',
	NOT_FOUND:
		"Rendobar has no job with that ID on this account. Pick one from the 'Job' list, and note that jobs are removed once their retention window passes.",
	GONE: 'The files for this job have passed their retention window. Submit the job again to produce them afresh.',
	CONFLICT:
		'Rendobar is holding the thing this applies to in a state that rules it out: a job that has already settled, an idempotency key already taken by another job, or an account that is at its webhook endpoint limit. Check where it stands with the Get operation, or in the Rendobar dashboard, then run the workflow again.',
	VALIDATION_ERROR:
		"Check 'Job Type', 'Inputs (JSON)' and 'Parameters' against the fields the node loads for that job type, then run the workflow again.",
	INVALID_JOB_TYPE:
		"Pick a job type from the 'Job Type' list. The list is loaded live from your account, so it always shows what you can run.",
	INPUT_URL_BLOCKED:
		"Rendobar would not fetch that address. Point 'Inputs (JSON)' at a publicly reachable HTTPS URL, or upload the file first with the File resource's Upload operation.",
	INPUT_FETCH_FAILED:
		"Rendobar could not download the input. Confirm the URL in 'Inputs (JSON)' is reachable and has not expired.",
	INPUT_NOT_MEDIA:
		"The input is not media this job type accepts. Check what 'Inputs (JSON)' points at.",
	INPUT_UNSUPPORTED:
		"This job type does not handle that input. Pick a different 'Job Type', or convert the input first.",
	QUEUE_EXPIRED:
		'The job waited so long to start that Rendobar cleared it. Submit it again, and if the account is busy let the running jobs finish first.',
	HTTP_ERROR:
		'Rendobar could not read the request. Check the values in this node, then run the workflow again.',
	PROCESSING_FAILED:
		"Open the job in the Rendobar dashboard to see what the runner reported, adjust 'Inputs (JSON)' or 'Parameters', then run the workflow again.",
	DISPATCH_EXHAUSTED: NEVER_RAN_DESCRIPTION,
	DISPATCH_UNAVAILABLE: NEVER_RAN_DESCRIPTION,
	DISPATCH_ERROR: NEVER_RAN_DESCRIPTION,
	PROVIDER_CLEARED: NEVER_RAN_DESCRIPTION,
	P1_EXECUTION_ERROR: NEVER_RAN_DESCRIPTION,
	RUNNER_ERROR: TRANSIENT_DESCRIPTION,
	RUNNER_TIMEOUT:
		"The job ran past its time budget. Raise the timeout in 'Parameters' if the job type offers one, or split the work into smaller jobs.",
	UPSTREAM_ERROR: TRANSIENT_DESCRIPTION,
	INTERNAL_ERROR: TRANSIENT_DESCRIPTION,
	NOT_CONFIGURED:
		'That capability is not switched on for this account. Contact Rendobar support to have it enabled.',
	NOT_IMPLEMENTED: 'Rendobar does not offer that yet. Pick a different operation or job type.',
};

// The spent-key CONFLICT needs its own line: the generic one tells the user to
// go and look at where something stands, not that the key is what is in the way
// and which parameter moves it.
//
// TRAP: n8n's "Retry On Fail" is NOT a way out. It re-runs the node inside the
// same execution with no attempt number, so the automatic key rebuilds
// identically onto the same spent key. What works is a key the user varies, or
// the automatic key, which the node renews when Rendobar reports one spent.
const SPENT_KEY_DESCRIPTION =
	"Rendobar keeps one job per idempotency key, so a key that is already taken cannot start a second one. Set 'Idempotency Key' to a value that changes between attempts, such as one ending in {{ $runIndex }}. Or leave it empty and let the node pick the key, which it renews as soon as Rendobar reports the old one spent. Open the named job with the Get operation to see what stopped it.";

/**
 * The job an idempotency key is already bound to.
 *
 * `POST /jobs` answers 409 CONFLICT when the key belongs to a job that stopped
 * with a retryable code: a key holds one job, so the resubmission cannot be
 * granted under it. `error.details.jobId` names it, and this is the only CONFLICT
 * in the API carrying details at all, so the ID's presence is the signal.
 */
export function spentKeyJobId(
	statusCode: number,
	body: JsonValue | undefined,
): string | undefined {
	if (statusCode !== 409) return undefined;
	const reported = objectAt(body, 'error');
	if (stringAt(reported, 'code') !== 'CONFLICT') return undefined;
	return stringAt(objectAt(reported, 'details'), 'jobId');
}

/** The guidance line for a Rendobar code, or undefined when there is none. */
export function describeApiCode(code: string): string | undefined {
	return DESCRIPTIONS[code];
}

/**
 * Builds the details for a non-2xx from Rendobar, whose body is always
 * `{ error: { code, message, details? } }`.
 */
export function failureFromResponse(
	statusCode: number,
	body: JsonValue | undefined,
	jobId?: string,
): FailureDetails {
	const reported = objectAt(body, 'error');
	const code = stringAt(reported, 'code') ?? `HTTP_${statusCode}`;

	// The one place the node overwrites Rendobar's headline. Rendobar says "Retry
	// with a new idempotency key", which is right for a client that mints its own
	// and wrong for a workflow builder who never saw one, since this node
	// generates it. Name the parameter and the job instead.
	const spentKeyJob = spentKeyJobId(statusCode, body);
	const message =
		spentKeyJob === undefined
			? (stringAt(reported, 'message') ?? `Rendobar responded with status ${statusCode}`)
			: `The idempotency key for this submission is already taken by job ${spentKeyJob}, which Rendobar stopped before it produced a result`;

	// An explicit ID from the caller wins; the body's is only the job a spent key
	// went to.
	const concerns = jobId ?? spentKeyJob;

	return {
		message,
		description:
			spentKeyJob === undefined
				? (DESCRIPTIONS[code] ?? GENERIC_DESCRIPTION)
				: SPENT_KEY_DESCRIPTION,
		code,
		// False, as every 409 is: the same call reproduces this answer while the key
		// is unchanged, so a workflow routing on `retryable` must not loop.
		retryable: isRetryable(statusCode, code),
		httpStatus: statusCode,
		...(concerns ? { jobId: concerns } : {}),
	};
}

/**
 * Whether repeating the call could succeed. The status decides unless the code
 * overrides it; a few answer with a transient status for a permanent cause.
 */
export function isRetryable(statusCode: number, code?: string): boolean {
	if (code !== undefined && NEVER_RETRYABLE_CODES.has(code)) return false;
	return RETRYABLE_STATUS_CODES.has(statusCode);
}

/**
 * Builds the details for a job Rendobar finished in the `failed` state. Such a
 * job carries `error: { code, message, detail, retryable, failedPhase? }`.
 */
export function failureFromJob(job: JsonObject, jobId: string): FailureDetails {
	const reported = objectAt(job, 'error');
	const code = stringAt(reported, 'code') ?? 'JOB_FAILED';
	const detail = stringAt(reported, 'detail');
	const summary = stringAt(reported, 'message');
	const failedPhase = stringAt(reported, 'failedPhase');

	// n8n renders `message` as the red headline, so it stays short and the
	// runner's output (often a long stderr tail) goes below. Rendobar falls back
	// to this exact string when the runner reported nothing, and repeating it
	// would put a word the n8n copy guidelines ban into the headline.
	const useful = summary === undefined || summary.trim().toLowerCase() === 'job failed' ? undefined : summary;

	const message = useful
		? `Rendobar stopped job ${jobId}: ${useful}`
		: `Rendobar stopped job ${jobId} before it produced a result`;

	const guidance = DESCRIPTIONS[code] ?? DESCRIPTIONS.PROCESSING_FAILED ?? GENERIC_DESCRIPTION;

	return {
		message,
		description: detail ? `${guidance}\n\nRendobar reported: ${detail}` : guidance,
		code,
		retryable: booleanAt(reported, 'retryable') ?? RETRYABLE_JOB_CODES.has(code),
		...(failedPhase ? { failedPhase } : {}),
		jobId,
	};
}

// n8n's error classes are the only thing `execute` may throw and have no slot for
// structured data, so the details are kept beside them and read back in `catch`.
const remembered = new WeakMap<Error, FailureDetails>();

export function rememberFailure<E extends Error>(error: E, details: FailureDetails): E {
	remembered.set(error, details);
	return error;
}

/**
 * The structured details for anything thrown inside `execute`, including what n8n
 * itself raised (a missing binary field, an unresolved expression), so the output
 * shape is the same every time.
 */
export function describeFailure(error: unknown): FailureDetails {
	if (!(error instanceof Error)) {
		return { message: String(error), code: 'NODE_ERROR', retryable: false };
	}

	const details = remembered.get(error);
	if (details) return details;

	// `Number('')` is 0 and finite, so an empty `httpCode` (what a transport-level
	// failure leaves) would report as `HTTP_0`.
	const reported = error instanceof NodeApiError ? error.httpCode : null;
	const parsed = reported === null || reported.trim() === '' ? Number.NaN : Number(reported);
	const httpStatus = Number.isFinite(parsed) ? parsed : undefined;

	// n8n's own error classes carry a `description`; a plain Error does not.
	const description = readString(error, 'description');

	return {
		message: error.message,
		...(description === undefined ? {} : { description }),
		code: httpStatus === undefined ? 'NODE_ERROR' : `HTTP_${httpStatus}`,
		retryable: httpStatus !== undefined && isRetryable(httpStatus),
		...(httpStatus === undefined ? {} : { httpStatus }),
	};
}

/**
 * The item pushed when "Continue On Fail" is on. `error` stays a plain string
 * because that is what n8n's docs and error output expect; the siblings beside it
 * are what make the item routable.
 */
export function failureItemJson(details: FailureDetails): JsonObject {
	return {
		error: details.message,
		code: details.code,
		retryable: details.retryable,
		...(details.description ? { description: details.description } : {}),
		...(details.httpStatus === undefined ? {} : { httpStatus: details.httpStatus }),
		...(details.failedPhase ? { failedPhase: details.failedPhase } : {}),
		...(details.jobId ? { jobId: details.jobId } : {}),
	};
}

/** The item marker the n8n UX guidelines ask for on a message. */
export function withItemMarker(message: string, itemIndex: number): string {
	return `${message} [item ${itemIndex}]`;
}

/** Builds the `NodeApiError` for a non-2xx, carrying its details for the catch. */
export function apiError(
	node: INode,
	details: FailureDetails,
	responseBody: JsonValue | undefined,
	itemIndex?: number,
): NodeApiError {
	const message =
		itemIndex === undefined ? details.message : withItemMarker(details.message, itemIndex);

	const error = new NodeApiError(node, objectAt(responseBody, 'error') ?? {}, {
		message,
		...(details.description ? { description: details.description } : {}),
		...(details.httpStatus === undefined ? {} : { httpCode: String(details.httpStatus) }),
		...(itemIndex === undefined ? {} : { itemIndex }),
	});

	return rememberFailure(error, { ...details, message });
}
