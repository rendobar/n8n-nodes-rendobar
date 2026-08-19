import type { JsonObject } from './json';
import { readString, readValue } from './json';

/**
 * Builds the `callback` object `POST /jobs` accepts, from the two parameters
 * the editor shows.
 *
 * Rendobar POSTs the finished job to this URL on every terminal state, which is
 * what lets an n8n workflow reach the platform's nine-hour job ceiling: point it
 * at a Wait node's resume URL and n8n persists the execution rather than holding
 * it open, so no worker is pinned and no poll loop has to outlive the job.
 *
 * Delivery is best effort rather than a guarantee. A call not answered with a
 * 2xx is retried five times over roughly the next five minutes and then given
 * up on, so a Wait node parked on a resume URL still needs its own 'Limit Wait
 * Time' to have a way out. The README says so beside the recipe.
 *
 * The result is a discriminated union rather than a throw, so the caller raises
 * the error naming the parameter at fault, the way every other reader here
 * works.
 */
export type CallbackResult =
	| { ok: true; callback: JsonObject | undefined }
	| { ok: false; parameter: 'Callback URL' | 'Callback Headers'; what: string; how: string };

const RESERVED_HEADER_PREFIX = 'x-rendobar-';

// Hosts Rendobar cannot reach. This is not a security control — the API runs its
// own check and is the authority on what it will accept. It exists so the
// mistake almost every self-hosted user makes first, pointing the callback at
// the loopback address n8n reports to itself, is answered with the fix instead
// of with "URL must use HTTPS".
const PRIVATE_HOST_PREFIX =
	/^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]$|\[fc00:|\[fe80:)/i;
const PRIVATE_HOST_SUFFIX = /(\.internal|\.local)$/i;

const TUNNEL_ADVICE =
	'Rendobar calls back from the public internet, so the address has to be one it can reach over HTTPS. On a local n8n, start it with a tunnel (n8n start --tunnel) or put it behind a public HTTPS address, then use the resume URL that gives you.';

/**
 * Reads the name/value rows of the Callback Headers collection into the object
 * the API takes. A row with no name is dropped rather than sent as an empty
 * header. A reserved name is reported instead of being quietly discarded,
 * because a header the user believes is being sent and is not would show up
 * later as an unexplained rejection at their own receiver.
 */
export function readCallbackHeaders(value: unknown): {
	headers: JsonObject;
	reserved: string | undefined;
} {
	const rows = readValue(value, 'header');
	const headers: JsonObject = {};
	let reserved: string | undefined;

	if (Array.isArray(rows)) {
		for (const row of rows) {
			const name = readString(row, 'name')?.trim();
			if (name === undefined || name === '') continue;
			if (name.toLowerCase().startsWith(RESERVED_HEADER_PREFIX)) {
				reserved ??= name;
				continue;
			}
			headers[name] = readString(row, 'value') ?? '';
		}
	}

	return { headers, reserved };
}

export function buildCallback(rawUrl: unknown, rawHeaders: unknown): CallbackResult {
	const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
	if (url === '') return { ok: true, callback: undefined };

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return {
			ok: false,
			parameter: 'Callback URL',
			what: 'is not a web address',
			how: 'Give it the full address Rendobar should call, starting with https://. In a workflow that pauses at a Wait node set to resume on a webhook call, that address is the expression {{ $execution.resumeUrl }}.',
		};
	}

	if (parsed.protocol !== 'https:') {
		return {
			ok: false,
			parameter: 'Callback URL',
			what: 'is not an https:// address',
			how: TUNNEL_ADVICE,
		};
	}

	if (PRIVATE_HOST_PREFIX.test(parsed.hostname) || PRIVATE_HOST_SUFFIX.test(parsed.hostname)) {
		return {
			ok: false,
			parameter: 'Callback URL',
			what: `points at ${parsed.hostname}, which only this machine can reach`,
			how: TUNNEL_ADVICE,
		};
	}

	const { headers, reserved } = readCallbackHeaders(rawHeaders);
	if (reserved !== undefined) {
		return {
			ok: false,
			parameter: 'Callback Headers',
			what: `sets ${reserved}, a name Rendobar keeps for itself`,
			how: 'Rendobar puts its own delivery details in the X-Rendobar-* headers. Name yours something else, such as Authorization or X-Api-Key.',
		};
	}

	const callback: JsonObject = { url };
	if (Object.keys(headers).length > 0) callback.headers = headers;
	return { ok: true, callback };
}

/**
 * Whether 'Wait for Completion' and 'Callback URL' were both asked for, which
 * is a combination that cannot work and is checked before the job is submitted.
 *
 * The two are alternatives, and using them together loses the callback for
 * certain — this is a sequence, not a race. Rendobar calls the address the
 * moment the job ends. At that moment this node is still inside its poll loop,
 * so the execution's status is `running` and n8n's waiting-webhook endpoint
 * answers 409 rather than resuming; Rendobar's five retries then run out over
 * the following few minutes. By the time the poll returns and the execution
 * reaches the Wait node there is nothing left to deliver, and a Wait node with
 * no 'Limit Wait Time' set has no ceiling — the execution parks for good.
 *
 * Refusing beats hiding one parameter behind the other: someone who has already
 * built the workflow reads what they set, told plainly which half to drop.
 * Refusing also beats quietly ignoring one of them, which would hand the next
 * node an unfinished job (or park the Wait node anyway) with nothing said. The
 * check runs before `POST /jobs`, so nothing is submitted or billed for a
 * submission that cannot be collected.
 */
export function waitAndCallbackConflict(
	hasCallback: boolean,
	waitForCompletion: boolean,
): { parameter: string; what: string; how: string } | undefined {
	if (!hasCallback || !waitForCompletion) return undefined;

	return {
		parameter: 'Wait for Completion',
		what: "cannot be used together with 'Callback URL'",
		how: "Rendobar calls the address in 'Callback URL' the moment the job ends, and at that moment this node is still polling, so n8n answers the call with a conflict and the delivery attempts run out before the execution reaches the Wait node. Turn off 'Wait for Completion' to let the Wait node park the execution, or clear 'Callback URL' to keep polling here.",
	};
}
