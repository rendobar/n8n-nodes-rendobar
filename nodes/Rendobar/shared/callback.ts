import type { JsonObject } from './json';
import { readString, readValue } from './json';

/**
 * The `callback` object `POST /jobs` accepts.
 *
 * Rendobar POSTs the finished job on every terminal state. Delivery is best
 * effort: a call not answered with a 2xx is retried five times over about five
 * minutes and then dropped, so a Wait node parked on a resume URL still needs
 * its own 'Limit Wait Time'.
 *
 * A union rather than a throw, so the caller raises the error naming the
 * parameter at fault.
 */
export type CallbackResult =
	| { ok: true; callback: JsonObject | undefined }
	| { ok: false; parameter: 'Callback URL' | 'Callback Headers'; what: string; how: string };

const RESERVED_HEADER_PREFIX = 'x-rendobar-';

// Hosts Rendobar cannot reach. Not a security control; the API runs its own
// check. This is here so the common self-hosted mistake, pointing the callback
// at the loopback address n8n reports to itself, gets the fix in the message.
const PRIVATE_HOST_PREFIX =
	/^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]$|\[fc00:|\[fe80:)/i;
const PRIVATE_HOST_SUFFIX = /(\.internal|\.local)$/i;

const TUNNEL_ADVICE =
	'Rendobar calls back from the public internet, so the address has to be one it can reach over HTTPS. On a local n8n, start it with a tunnel (n8n start --tunnel) or put it behind a public HTTPS address, then use the resume URL that gives you.';

/**
 * The Callback Headers rows as the object the API takes. A row with no name is
 * dropped. A reserved name is reported rather than discarded: a header the user
 * thinks is being sent would otherwise surface as a rejection at their receiver.
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
 * Whether 'Wait for Completion' and 'Callback URL' were both set. Checked before
 * `POST /jobs`, so nothing is billed for a submission that cannot be collected.
 *
 * The combination loses the callback every time, not sometimes. Rendobar calls
 * the moment the job ends; this node is still polling, so the execution is
 * `running` and n8n's waiting-webhook endpoint answers 409. The five retries run
 * out before the poll returns and the execution reaches the Wait node, which
 * then parks for good unless 'Limit Wait Time' is set.
 *
 * Refused rather than hidden or ignored: the user reads back what they set and
 * is told which half to drop.
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
