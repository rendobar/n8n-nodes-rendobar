import { NodeApiError, type INode } from 'n8n-workflow';
import { booleanAt, objectAt, readString, stringAt, type JsonObject, type JsonValue } from './json';

// One description of "what went wrong" for the whole node, so a workflow can
// branch on the same fields no matter which operation produced it.
//
// Two things read this:
//   - the thrown `NodeApiError` / `NodeOperationError`, which n8n renders in the
//     output panel, and
//   - the item pushed on the output when "Continue On Fail" is on, which is
//     where `code` / `retryable` / `failedPhase` earn their keep: an opaque
//     string cannot be routed by an If or a Switch node.
//
// Copy rule (n8n UX guidelines): `message` says what happened, `description`
// says how to get unstuck, and neither may use the words "error", "problem",
// "failure" or "mistake". Text Rendobar itself returns is passed through as-is,
// because the guidelines also say to use the service's own vocabulary.
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

// Job-level codes Rendobar treats as retryable. The API sends `retryable` on the
// job itself, so this is only the fallback for a job that arrives without it.
// `DISPATCH_EXHAUSTED` is what the dead-letter consumer actually writes onto a
// job it could not dispatch; `DISPATCH_ERROR` is the code the API's own
// retryable set names, so both are honoured here.
const RETRYABLE_JOB_CODES = new Set([
	'DISPATCH_ERROR',
	'DISPATCH_EXHAUSTED',
	'RUNNER_TIMEOUT',
	'RUNNER_ERROR',
]);

// Codes whose HTTP status suggests a retry but whose cause cannot clear on one.
// `NOT_CONFIGURED` answers 503, yet it means a capability is switched off for
// the account: repeating the call forever is exactly the wrong advice, and it
// contradicts the guidance shown beside it.
const NEVER_RETRYABLE_CODES = new Set(['NOT_CONFIGURED', 'NOT_IMPLEMENTED']);

const GENERIC_DESCRIPTION =
	'Check the values in this node against the Rendobar dashboard, then run the workflow again.';

const TRANSIENT_DESCRIPTION =
	'This is usually temporary and the node already retried. Run the workflow again in a moment. If it keeps happening, contact Rendobar support with the job ID.';

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
		'Whatever this applies to is already in a state that rules it out. Check where it stands — a job with the Get operation, anything else in the Rendobar dashboard — then run the workflow again.',
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
	RUNNER_ERROR: TRANSIENT_DESCRIPTION,
	RUNNER_TIMEOUT:
		"The job ran past its time budget. Raise the timeout in 'Parameters' if the job type offers one, or split the work into smaller jobs.",
	UPSTREAM_ERROR: TRANSIENT_DESCRIPTION,
	INTERNAL_ERROR: TRANSIENT_DESCRIPTION,
	NOT_CONFIGURED:
		'That capability is not switched on for this account. Contact Rendobar support to have it enabled.',
	NOT_IMPLEMENTED: 'Rendobar does not offer that yet. Pick a different operation or job type.',
};

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
	const message = stringAt(reported, 'message') ?? `Rendobar responded with status ${statusCode}`;

	return {
		message,
		description: DESCRIPTIONS[code] ?? GENERIC_DESCRIPTION,
		code,
		retryable: isRetryable(statusCode, code),
		httpStatus: statusCode,
		...(jobId ? { jobId } : {}),
	};
}

/**
 * Whether repeating the same call could succeed. The status decides it unless
 * the code says otherwise: a handful of codes answer with a status that reads
 * transient while describing something no retry can change.
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
	// runner's own output — which can be a long stderr tail — goes below it.
	// Rendobar falls back to this exact string when the runner reported nothing
	// useful; repeating it would add no information and would put a word the
	// n8n copy guidelines rule out into the headline.
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

// n8n's error classes are the only thing `execute` may throw, and they have no
// slot for structured data. Rather than bolt extra properties onto their
// instances, the details are kept beside them and read back in the catch block.
const remembered = new WeakMap<Error, FailureDetails>();

export function rememberFailure<E extends Error>(error: E, details: FailureDetails): E {
	remembered.set(error, details);
	return error;
}

/**
 * Recovers the structured details for anything thrown inside `execute`,
 * including errors n8n itself raised (a missing binary field, an expression
 * that did not resolve), so the output has the same shape every time.
 */
export function describeFailure(error: unknown): FailureDetails {
	if (!(error instanceof Error)) {
		return { message: String(error), code: 'NODE_ERROR', retryable: false };
	}

	const details = remembered.get(error);
	if (details) return details;

	// `Number('')` is 0 and 0 is finite, so an empty `httpCode` — which is what
	// a transport-level failure leaves behind — would otherwise be reported as
	// the status `HTTP_0`.
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
 * The item pushed onto the output when "Continue On Fail" is on. `error` stays
 * a plain string because that is the field n8n's own docs and error output
 * expect; the siblings beside it are what make the item routable.
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

/**
 * Appends the marker the n8n UX guidelines ask for, so a reader of the output
 * panel can tell which input item a message belongs to.
 */
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
