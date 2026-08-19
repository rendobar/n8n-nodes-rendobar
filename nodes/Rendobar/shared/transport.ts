import {
	NodeOperationError,
	sleep,
	type IExecuteFunctions,
	type IHookFunctions,
	type IHttpRequestMethods,
	type IBinaryData,
	type IHttpRequestOptions,
	type ILoadOptionsFunctions,
	type INode,
} from 'n8n-workflow';
import { apiError, failureFromResponse, rememberFailure } from './failure';
import { numberAt, objectAt, objectsAt, stringAt, type JsonObject, type JsonValue } from './json';

export type RendobarContext = IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions;

const DEFAULT_BASE_URL = 'https://api.rendobar.com';

// Matches the Rendobar SDK's default. n8n's HTTP helper has no timeout of its
// own, so without this a stalled connection holds the execution open until the
// whole workflow times out.
export const REQUEST_TIMEOUT_MS = 30_000;

// A single upload part is up to 100 MB (Rendobar's PUT/multipart switch point),
// which needs a far longer budget than a JSON call on a slow uplink.
export const TRANSFER_TIMEOUT_MS = 600_000;

// One try plus two retries, the same budget the Rendobar SDK uses.
export const MAX_ATTEMPTS = 3;

const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;

const THROTTLED_STATUS = 429;
const TRANSIENT_SERVER_STATUS = new Set([500, 502, 503, 504]);

// Rendobar answers 429 for two unrelated reasons and they need opposite
// handling.
//
// `RATE_LIMITED` is raised by middleware before the route body runs, so nothing
// happened and repeating the call is free.
//
// `QUEUE_FULL` is raised deep inside job submission — after the compose-assist
// window has already probed every input asset and run a model over them, both
// of which are billed. Repeating that call re-runs and re-bills all of it, and
// a queue does not drain inside a backoff measured in seconds anyway. So it is
// reported to the user as something they can retry later, but never retried
// here.
const NEVER_RETRIED_CODES = new Set(['QUEUE_FULL']);

export interface RendobarRequest {
	method: IHttpRequestMethods;
	/** Path below the base URL, already encoded. */
	path: string;
	body?: JsonObject;
	qs?: Record<string, string | number | boolean>;
	/**
	 * True when repeating the request after a server-side stall cannot duplicate
	 * a side effect — every GET and DELETE, and the POSTs that either carry an
	 * idempotency key or settle to the same state twice. Left false for calls
	 * that create something new, so a retry cannot leave a stray record behind.
	 */
	idempotent?: boolean;
	timeoutMs?: number;
}

export interface RendobarResponse {
	statusCode: number;
	body: JsonValue;
}

/**
 * n8n's full-response envelope. The helper's own return type is `any` because
 * the shape depends on `returnFullResponse` and `encoding`, so this is the one
 * declaration the values are trusted against.
 */
interface FullResponse {
	statusCode: number;
	headers: Record<string, string | string[] | undefined>;
	body: JsonValue;
}

/**
 * Reads `Retry-After`, which RFC 9110 allows in either delta-seconds or
 * HTTP-date form. Returns seconds to wait, or undefined when the header is
 * absent or unreadable. Rendobar does not send it today, but Cloudflare and any
 * proxy in front of it may, and honouring it is strictly better than guessing.
 */
export function parseRetryAfter(
	header: string | string[] | undefined,
	nowMs: number,
): number | undefined {
	const value = Array.isArray(header) ? header[0] : header;
	if (typeof value !== 'string' || value.trim() === '') return undefined;

	const seconds = Number(value.trim());
	if (Number.isFinite(seconds)) return Math.max(0, seconds);

	const at = Date.parse(value);
	return Number.isNaN(at) ? undefined : Math.max(0, (at - nowMs) / 1000);
}

/**
 * Exponential backoff with jitter. The jitter matters because an n8n workflow
 * fans a batch of items out at once: without it every item retries on the same
 * tick and rebuilds the burst that caused the throttling.
 */
export function retryDelayMs(attempt: number, retryAfterSeconds?: number): number {
	if (retryAfterSeconds !== undefined) {
		return Math.min(Math.round(retryAfterSeconds * 1000), MAX_RETRY_DELAY_MS);
	}
	const backoff = Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
	return backoff + Math.floor(Math.random() * backoff);
}

export function shouldRetryStatus(
	statusCode: number,
	idempotent: boolean,
	code?: string,
): boolean {
	if (code !== undefined && NEVER_RETRIED_CODES.has(code)) return false;
	if (statusCode === THROTTLED_STATUS) return true;
	return idempotent && TRANSIENT_SERVER_STATUS.has(statusCode);
}

/** The Rendobar code on a non-2xx body, when it carries one. */
function responseCode(body: JsonValue): string | undefined {
	return stringAt(objectAt(body, 'error'), 'code');
}

function baseUrlFor(credentials: { baseUrl?: unknown }): string {
	const configured = credentials.baseUrl;
	if (typeof configured !== 'string') return DEFAULT_BASE_URL;
	const trimmed = configured.trim().replace(/\/+$/, '');
	return trimmed === '' ? DEFAULT_BASE_URL : trimmed;
}

function unreachable(node: INode, url: string, cause: unknown): NodeOperationError {
	const reason = cause instanceof Error ? cause.message : String(cause);
	const error = new NodeOperationError(node, `Rendobar did not answer at ${url}`, {
		description: `Check that this n8n instance can reach the internet and that 'Base URL' in the Rendobar credential is correct, then run the workflow again. The connection reported: ${reason}`,
	});
	return rememberFailure(error, {
		message: `Rendobar did not answer at ${url}`,
		code: 'CONNECTION_FAILED',
		retryable: true,
	});
}

/**
 * Sends one request, retrying transient answers, and hands back the response
 * whatever its status. Callers that care only about success use
 * {@link rendobarApiRequest}; callers that need to see a 404 as data — the
 * trigger checking whether its endpoint still exists — use this.
 */
export async function rendobarRequest(
	this: RendobarContext,
	spec: RendobarRequest,
): Promise<RendobarResponse> {
	const credentials = await this.getCredentials('rendobarApi');
	const url = `${baseUrlFor(credentials)}${spec.path}`;
	const idempotent = spec.idempotent ?? false;

	const options: IHttpRequestOptions = {
		method: spec.method,
		url,
		json: true,
		timeout: spec.timeoutMs ?? REQUEST_TIMEOUT_MS,
		returnFullResponse: true,
		// Statuses are handled here rather than as thrown exceptions so the retry
		// decision and the message both work from the parsed body.
		ignoreHttpStatusErrors: true,
	};
	if (spec.qs !== undefined) options.qs = spec.qs;
	if (spec.body !== undefined) options.body = spec.body;

	for (let attempt = 1; ; attempt++) {
		let response: FullResponse;
		try {
			// The helper is typed `any`; the options above pin the shape to n8n's
			// full-response envelope with a JSON-parsed body. This is the single
			// point where an untyped value enters the package — everything past it
			// is narrowed with the guards in ./json.
			response = (await this.helpers.httpRequestWithAuthentication.call(
				this,
				'rendobarApi',
				options,
			)) as FullResponse;
		} catch (cause) {
			// No response came back, so the request may or may not have been acted
			// on. Only repeat it when doing so cannot duplicate anything.
			if (attempt >= MAX_ATTEMPTS || !idempotent) throw unreachable(this.getNode(), url, cause);
			await sleep(retryDelayMs(attempt));
			continue;
		}

		if (
			attempt >= MAX_ATTEMPTS ||
			!shouldRetryStatus(response.statusCode, idempotent, responseCode(response.body))
		) {
			return { statusCode: response.statusCode, body: response.body };
		}

		await sleep(
			retryDelayMs(attempt, parseRetryAfter(response.headers['retry-after'], Date.now())),
		);
	}
}

/**
 * Sends one request and returns its parsed body, raising a well-formed n8n
 * error for any non-2xx.
 */
export async function rendobarApiRequest(
	this: RendobarContext,
	spec: RendobarRequest,
	itemIndex?: number,
): Promise<JsonValue> {
	const response = await rendobarRequest.call(this, spec);
	if (response.statusCode >= 200 && response.statusCode < 300) return response.body;

	throw apiError(
		this.getNode(),
		failureFromResponse(response.statusCode, response.body),
		response.body,
		itemIndex,
	);
}

// ── Uploads ───────────────────────────────────────────────────────────────

/**
 * A file to send, described without holding it in memory. `size` is needed up
 * front because `POST /assets` decides between a single PUT and a multipart
 * upload from the declared byte count.
 */
export interface UploadSource {
	size: number;
	/**
	 * Yields the bytes in whatever pieces the underlying store hands over.
	 * Regrouping into upload parts is {@link chunkStream}'s job, so nothing here
	 * has to know how large a part is.
	 */
	read(): AsyncIterable<Buffer>;
}

/**
 * Regroups a stream of arbitrary chunks into buffers of exactly `chunkSize`
 * bytes, with a shorter final one. Holds at most one chunk plus one inbound
 * read at a time, which is what keeps a multi-gigabyte upload inside a fixed
 * memory ceiling.
 */
export async function* chunkStream(
	source: AsyncIterable<Buffer>,
	chunkSize: number,
): AsyncGenerator<Buffer> {
	let pending: Buffer[] = [];
	let pendingBytes = 0;

	for await (const part of source) {
		pending.push(part);
		pendingBytes += part.length;

		while (pendingBytes >= chunkSize) {
			const joined = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
			yield joined.subarray(0, chunkSize);
			const rest = joined.subarray(chunkSize);
			pending = rest.length > 0 ? [rest] : [];
			pendingBytes = rest.length;
		}
	}

	if (pendingBytes > 0) {
		yield pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
	}
}

/**
 * Describes the binary data on an item as an {@link UploadSource}.
 *
 * When n8n is running in its filesystem or S3 binary mode the payload lives
 * outside the process and is read back a chunk at a time, so a file far larger
 * than the heap still uploads. Only in the legacy in-memory mode is the whole
 * item already resident, and there reading it costs nothing extra.
 */
export async function binaryUploadSource(
	ctx: IExecuteFunctions,
	itemIndex: number,
	binaryProperty: string,
	binary: IBinaryData,
): Promise<UploadSource> {
	const binaryId = binary.id;

	if (typeof binaryId === 'string') {
		const { fileSize } = await ctx.helpers.getBinaryMetadata(binaryId);
		return {
			size: fileSize,
			read: () => ({
				async *[Symbol.asyncIterator]() {
					const stream = await ctx.helpers.getBinaryStream(binaryId);
					for await (const part of stream) {
						yield Buffer.isBuffer(part) ? part : Buffer.from(String(part));
					}
				},
			}),
		};
	}

	// In-memory mode: the item already holds the bytes, so there is nothing to
	// stream and handing the buffer over costs nothing extra. `chunkStream`
	// slices it into parts with `subarray`, which are views rather than copies.
	const buffer = await ctx.helpers.getBinaryDataBuffer(itemIndex, binaryProperty);
	return {
		size: buffer.length,
		read: () => ({
			async *[Symbol.asyncIterator]() {
				yield buffer;
			},
		}),
	};
}

/** Sends one chunk to a presigned URL and returns the ETag the store assigned. */
async function putChunk(
	ctx: IExecuteFunctions,
	url: string,
	chunk: Buffer,
	contentType: string,
	itemIndex: number,
): Promise<string | undefined> {
	for (let attempt = 1; ; attempt++) {
		let response: FullResponse;
		try {
			// Presigned URLs carry their own signature, so these must NOT include
			// the Rendobar credential — hence the plain helper, not the
			// authenticating one. Same untyped-boundary note as above.
			response = (await ctx.helpers.httpRequest({
				method: 'PUT',
				url,
				body: chunk,
				headers: { 'Content-Type': contentType },
				json: false,
				timeout: TRANSFER_TIMEOUT_MS,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
			})) as FullResponse;
		} catch (cause) {
			// A PUT of the same bytes to the same key settles to the same object,
			// so repeating it is always safe.
			if (attempt >= MAX_ATTEMPTS) throw unreachable(ctx.getNode(), url, cause);
			await sleep(retryDelayMs(attempt));
			continue;
		}

		if (response.statusCode >= 200 && response.statusCode < 300) {
			const etag = response.headers.etag ?? response.headers.ETag;
			return Array.isArray(etag) ? etag[0] : etag;
		}

		if (attempt >= MAX_ATTEMPTS || !shouldRetryStatus(response.statusCode, true)) {
			const details = failureFromResponse(response.statusCode, response.body);
			throw apiError(
				ctx.getNode(),
				{
					...details,
					message: `Rendobar's storage would not accept the file (status ${response.statusCode})`,
					description:
						'Presigned upload links are valid for six hours. Run the workflow again to request a fresh one.',
				},
				response.body,
				itemIndex,
			);
		}

		await sleep(
			retryDelayMs(attempt, parseRetryAfter(response.headers['retry-after'], Date.now())),
		);
	}
}

/**
 * Guards the one way this upload could go wrong quietly: the byte count
 * declared to `POST /assets` decides how storage assembles the object, so if
 * the file read back a different length the stored file would be wrong with no
 * complaint from anyone.
 */
export function assertWholeFileSent(
	node: INode,
	sent: number,
	declared: number,
	itemIndex: number,
	moreRemaining = false,
): void {
	if (sent === declared && !moreRemaining) return;

	const measured = moreRemaining ? `more than ${sent}` : `${sent}`;
	const message = `The file in 'Input Binary Field' measured ${declared} bytes but ${measured} were read`;
	throw rememberFailure(
		new NodeOperationError(node, message, {
			itemIndex,
			description:
				'Run the workflow again. If the node before this one is still writing the file while this one reads it, let it finish first.',
		}),
		{ message, code: 'FILE_SIZE_CHANGED', retryable: true },
	);
}

function malformedUploadResponse(node: INode, what: string, itemIndex: number): NodeOperationError {
	const message = `Rendobar's upload response did not include ${what}`;
	const error = new NodeOperationError(node, message, {
		itemIndex,
		description:
			'Run the workflow again. If it keeps happening, contact Rendobar support so they can look at the upload service.',
	});
	return rememberFailure(error, { message, code: 'UPLOAD_RESPONSE_INVALID', retryable: true });
}

/**
 * Uploads a file through the Rendobar asset flow: reserve, send the bytes
 * straight to storage over the presigned link(s), then finalize. The bytes
 * never pass through the Rendobar API. Returns the ready asset, whose `url` is
 * what a job takes as an input.
 */
export async function rendobarUpload(
	this: IExecuteFunctions,
	source: UploadSource,
	filename: string,
	contentType: string,
	itemIndex: number,
): Promise<JsonValue> {
	if (source.size <= 0) {
		const message = `The file in 'Input Binary Field' holds no data`;
		throw rememberFailure(
			new NodeOperationError(this.getNode(), message, {
				itemIndex,
				description:
					"Point 'Input Binary Field' at the field holding the file, and check the node before this one actually produced one.",
			}),
			{ message, code: 'EMPTY_FILE', retryable: false },
		);
	}

	// 1. Reserve the asset and learn how the bytes should be sent. Deliberately
	// not marked idempotent: a repeat after a stalled response would reserve a
	// second asset rather than settle the first.
	const init = await rendobarApiRequest.call(
		this,
		{
			method: 'POST',
			path: '/assets',
			body: { filename, size: source.size, contentType, lifecycle: 'ephemeral' },
		},
		itemIndex,
	);

	const status = stringAt(init, 'status');

	// An identical file already exists on the account, so there is nothing to
	// send and the asset is ready to use as it stands.
	if (status === 'deduplicated') return init;

	const asset = objectAt(init, 'data');
	const assetId = stringAt(asset, 'id');
	const upload = objectAt(init, 'upload');
	if (assetId === undefined || upload === undefined) {
		throw malformedUploadResponse(this.getNode(), 'an upload target', itemIndex);
	}

	let completeBody: JsonObject | undefined;

	if (status === 'multipart') {
		const partSize = numberAt(upload, 'partSize');
		const parts = objectsAt(upload, 'parts');
		if (partSize === undefined || partSize <= 0 || parts.length === 0) {
			throw malformedUploadResponse(this.getNode(), 'the parts to send the file in', itemIndex);
		}

		// One part is read, sent and released before the next is read, so peak
		// memory is one part regardless of how large the file is.
		const uploaded: JsonObject[] = [];
		const chunks = chunkStream(source.read(), partSize);
		let sent = 0;
		// Rendobar sized the part list from the byte count declared at init. A
		// source that turned out to be longer fills every one of those parts and
		// leaves the remainder unsent, and because the parts are full the byte
		// count alone still adds up — so the leftover has to be looked for.
		let moreRemaining = false;

		try {
			for (const part of parts) {
				const url = stringAt(part, 'url');
				const partNumber = numberAt(part, 'partNumber');
				if (url === undefined || partNumber === undefined) {
					throw malformedUploadResponse(this.getNode(), 'a link for every part', itemIndex);
				}

				const next = await chunks.next();
				if (next.done === true) break;

				const etag = await putChunk(this, url, next.value, contentType, itemIndex);
				if (etag === undefined) {
					throw malformedUploadResponse(this.getNode(), 'a tag for an uploaded part', itemIndex);
				}
				uploaded.push({ partNumber, etag });
				sent += next.value.length;
			}

			moreRemaining = (await chunks.next()).done !== true;
		} finally {
			// Closes the underlying read, whether the loop finished or threw.
			await chunks.return(undefined);
		}

		assertWholeFileSent(this.getNode(), sent, source.size, itemIndex, moreRemaining);
		completeBody = { parts: uploaded };
	} else if (status === 'presigned') {
		const url = stringAt(upload, 'url');
		if (url === undefined) {
			throw malformedUploadResponse(this.getNode(), 'an upload target', itemIndex);
		}

		// Under the multipart threshold the file goes in one request, so the whole
		// of it is gathered first — bounded by that threshold, not by the file.
		// Rendobar reads the tag back from storage itself, so `complete` needs no
		// body.
		const collected: Buffer[] = [];
		let sent = 0;
		for await (const chunk of source.read()) {
			collected.push(chunk);
			sent += chunk.length;
		}

		assertWholeFileSent(this.getNode(), sent, source.size, itemIndex);
		// Concatenating a single buffer would copy it for nothing, and at this
		// point that buffer can be the whole 100 MB.
		const body = collected.length === 1 ? collected[0] : Buffer.concat(collected, sent);
		await putChunk(this, url, body, contentType, itemIndex);
	} else {
		// `POST /assets` answers with presigned, multipart or deduplicated. A
		// fourth would otherwise fall through the single-PUT branch and send the
		// file somewhere it does not belong.
		throw malformedUploadResponse(this.getNode(), 'an upload method this node knows', itemIndex);
	}

	// 2. Finalize. Verifying an already-verified asset settles to the same
	// state, so this one is safe to repeat.
	return await rendobarApiRequest.call(
		this,
		{
			method: 'POST',
			path: `/assets/${encodeURIComponent(assetId)}/complete`,
			...(completeBody === undefined ? {} : { body: completeBody }),
			idempotent: true,
		},
		itemIndex,
	);
}
