import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	sleep,
	type IExecuteFunctions,
	type INode,
	type INodeExecutionData,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';
import {
	binaryUploadSource,
	rendobarApiRequest,
	rendobarRequest,
	rendobarUpload,
	TRANSFER_TIMEOUT_MS,
} from './shared/transport';
import {
	apiError,
	describeFailure,
	failureFromJob,
	failureFromResponse,
	failureItemJson,
	rememberFailure,
	spentKeyJobId,
	withItemMarker,
} from './shared/failure';
import {
	arrayAt,
	booleanAt,
	isJsonObject,
	numberAt,
	objectAt,
	readJsonParameter,
	readNumber,
	readObject,
	readString,
	readValue,
	readUnixMs,
	stringAt,
	unwrapData,
	type JsonObject,
	type JsonValue,
} from './shared/json';
import { buildCallback, waitAndCallbackConflict } from './shared/callback';
import { getJobTypes } from './listSearch/getJobTypes';
import { getJobs } from './listSearch/getJobs';
import { getJobFields } from './methods/getJobFields';
import { getJobInputFields } from './methods/getJobInputFields';
import {
	ASSET_FIELDS,
	buildAssetItem,
	buildJobItem,
	JOB_FIELDS,
	titleCaseFieldName,
	type OutputMode,
} from './shared/output';

const TERMINAL_STATUSES = new Set(['complete', 'failed', 'cancelled']);

// GET /jobs caps a page at 100. Return All walks pages of this size.
const MAX_PAGE_SIZE = 100;

// What n8n's binary store accepts: a Buffer or a readable stream. Taken from
// the helper's own signature because a community node may not import
// `node:stream` to name `Readable` directly.
type BinaryPayload = Parameters<IExecuteFunctions['helpers']['prepareBinaryData']>[0];

// Acronyms the generic humanizer would title-case into something n8n's style
// guide rejects ("Id", "Url").
const FIELD_LABEL_OVERRIDES: Record<string, string> = {
	id: 'ID',
	orgId: 'Org ID',
	webUrl: 'Web URL',
	url: 'URL',
	eta: 'ETA',
	etag: 'ETag',
};

// Derived from the single source of truth in shared/output.ts, so there is no
// second hand-kept list. Sorted on the label rather than the field name,
// because that is what the user reads and the overrides above move some of them
// (`eta` reads as "ETA", `webUrl` as "Web URL").
function fieldOptions(fields: readonly string[]): INodePropertyOptions[] {
	return fields
		.map((field) => ({
			name: FIELD_LABEL_OVERRIDES[field] ?? titleCaseFieldName(field),
			value: field,
		}))
		.sort((left, right) => left.name.localeCompare(right.name));
}

const JOB_FIELD_OPTIONS: INodePropertyOptions[] = fieldOptions(JOB_FIELDS);
const ASSET_FIELD_OPTIONS: INodePropertyOptions[] = fieldOptions(ASSET_FIELDS);

// ── Parameter readers ─────────────────────────────────────────────────────
// `getNodeParameter` hands back a broad union. These turn one into the value
// the code below actually needs, without asserting a shape nothing checked.

function toOutputMode(value: unknown): OutputMode {
	return value === 'raw' || value === 'selected' ? value : 'simplified';
}

function toStringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === 'string')
		: [];
}

function toIdentifier(value: unknown): string {
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number') return String(value);
	return '';
}

/**
 * `typeOptions.minValue` only constrains what the editor lets you type; an
 * expression can still resolve to zero or a negative number at run time. A poll
 * interval of zero would spin against the API, and a negative page size is read
 * by SQLite as "no limit", so the floor is enforced here as well.
 */
function toWholeNumber(value: unknown, fallback: number, minimum: number): number {
	const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
	return Math.max(minimum, number);
}

/**
 * Serialises a submission the same way every time, whatever order the keys
 * arrive in. n8n rebuilds a resource-mapper value from the stored parameters on
 * each run, so relying on insertion order would make the same submission
 * fingerprint differently between runs.
 */
export function stableStringify(value: JsonValue): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

	const body = Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
		.join(',');
	return `{${body}}`;
}

/**
 * A short, stable fingerprint of what is being submitted.
 *
 * This is not a security boundary — it only has to differ between two different
 * submissions, so a pair of FNV-1a-style passes is plenty and keeps the node
 * free of the `node:crypto` import a verified community node may not have.
 */
export function fingerprint(value: JsonValue): string {
	const text = stableStringify(value);
	let low = 0x811c9dc5;
	let high = 0x9e3779b9;

	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		low = Math.imul(low ^ code, 0x01000193) >>> 0;
		high = Math.imul(high ^ code, 0x85ebca6b) >>> 0;
	}

	return `${low.toString(36)}${high.toString(36)}`;
}

/**
 * The key that replaces one Rendobar has reported spent.
 *
 * `POST /jobs` binds a key to exactly one job and keeps that binding after the
 * job ends. Once the job it created has stopped with a code Rendobar itself
 * calls retryable, the key can no longer do anything: it cannot hand back a
 * usable job and it cannot start a second one, so the API answers 409 and names
 * the job it is stuck on. The way out is a different key.
 *
 * Derived from the base key rather than from the previous one, so the chain
 * stays a constant length however many attempts walk it, and derived from the
 * job ID rather than from a counter or a random value, so it is a pure function
 * of what Rendobar just said. That is what keeps the guarantee the key exists
 * for: two deliveries of the SAME attempt see the same 409 naming the same job,
 * build the same replacement, and settle on one job — while two different
 * submissions still differ in the base key and can never meet here.
 */
export function retryKeyFor(baseKey: string, boundJobId: string): string {
	return `${baseKey}~${boundJobId}`;
}

/**
 * How many spent keys one pass of `execute` will walk past before it reports
 * the conflict instead.
 *
 * n8n hands a node no attempt number — `execute()` is re-invoked with an
 * identical signature and an identical `this` on every try of Retry On Fail, so
 * nothing the node can read distinguishes try 3 from try 1 (checked against
 * n8n-workflow 2.16.0: no `getTryIndex`, nothing per-attempt on `INode`,
 * `IExecuteData`, `ITaskData` or the expression proxy, and `$runIndex` counts
 * loop passes, not tries). What the node CAN read is the budget: `maxTries` is
 * on the node object.
 *
 * That budget is the right size. Try N of Retry On Fail rebuilds the same base
 * key, so it meets the job try 1 created, then the job try 2 created, and so on
 * — one hop per attempt already spent. Anything beyond the node's own retry
 * budget is not a case Retry On Fail can produce, so it is reported rather than
 * chased, and the ceiling keeps a hand-edited `maxTries` from turning one item
 * into an unbounded run of submissions.
 *
 * Retry On Fail off means no attempt can already be spent, so one try is all
 * this ever needs.
 */
export function spentKeyBudget(node: INode): number {
	if (node.retryOnFail !== true) return 1;
	// n8n's own default when Retry On Fail is switched on without touching it.
	const tries = readNumber(node, 'maxTries') ?? 3;
	return Math.min(10, Math.max(1, Math.floor(tries)));
}

/**
 * Submits one job, moving off an idempotency key Rendobar reports as spent.
 *
 * `rendobarRequest` rather than `rendobarApiRequest`, because the 409 is data
 * here before it is a stop: it is the API telling us the key we chose is bound
 * to a job that stopped without ever reaching a runner, and that a resubmission
 * under it is impossible. Nothing is duplicated by moving off it — the job it
 * names produced no result and is over — so the deliberate retry the caller
 * asked for is granted under {@link retryKeyFor} instead of being reported as
 * something the workflow builder has to go and fix.
 *
 * `budget` is what stops that being a licence to submit forever: one attempt
 * per key the caller could plausibly have spent, and no more. When it runs out,
 * or when the 409 is any other conflict, the response is raised with the copy
 * in ./shared/failure.
 */
export async function submitJob(
	this: IExecuteFunctions,
	submission: JsonObject,
	baseKey: string,
	budget: number,
	itemIndex: number,
): Promise<JsonValue> {
	let idempotencyKey = baseKey;

	for (let attempt = 1; ; attempt++) {
		const response = await rendobarRequest.call(this, {
			method: 'POST',
			path: '/jobs',
			body: { ...submission, idempotencyKey },
			// Safe to repeat: the key means a second delivery of THIS attempt
			// settles on the job the first delivery created rather than a new one.
			idempotent: true,
		});

		if (response.statusCode >= 200 && response.statusCode < 300) return response.body;

		const boundJobId = spentKeyJobId(response.statusCode, response.body);
		if (boundJobId === undefined || attempt >= budget) {
			throw apiError(
				this.getNode(),
				failureFromResponse(response.statusCode, response.body),
				response.body,
				itemIndex,
			);
		}

		idempotencyKey = retryKeyFor(baseKey, boundJobId);
	}
}

/**
 * How many of a page's usable rows still fit inside 'Limit'.
 *
 * The server is trusted to honour the limit that was asked for, but not relied
 * on: if it ever clamps or ignores it, the surplus is dropped here rather than
 * handed to the workflow.
 */
export function roomFor(limit: number, taken: number, available: number): number {
	if (limit === Infinity) return available;
	return Math.min(available, Math.max(0, limit - taken));
}

/**
 * Whether the last page was the end of the list.
 *
 * `rowCount` is how many rows the API sent, NOT how many survived narrowing: a
 * row that is not an object still occupies an offset slot, so counting only the
 * usable ones would re-request it on the next page and read it twice — and
 * would end a Return All early, because a short page reads as the end.
 */
export function pageExhausted(
	rowCount: number,
	pageSize: number,
	offset: number,
	total?: number,
): boolean {
	return rowCount < pageSize || (total !== undefined && offset >= total);
}

/**
 * The rows of a page that have not been handed to the workflow already.
 *
 * `GET /jobs` pages by offset over an ordering that has no tiebreaker under it —
 * creation time alone — and jobs really are created inside the same
 * millisecond, so two page queries are free to order those rows differently and
 * put one of them in both pages. A job created while a Return All is still
 * walking the pages does the same thing from the other end, by pushing every row
 * behind it one slot along. Neither is something this node can correct from
 * here: it can only see a job it has already emitted, and refuse to emit it
 * twice. A row that moved the other way, out of the window between two requests,
 * is not recoverable at all — which is why the README does not call Return All a
 * snapshot, and points at 'Created Before' for a run that has to be exact.
 *
 * `seen` is not written here. The caller adds the IDs it actually emits, so a
 * row trimmed off by 'Limit' is not marked as delivered when it was not.
 *
 * A row whose `id` is not a string is kept: it cannot be recognised on a later
 * page either way, and dropping data because it could not be identified would be
 * worse than repeating it.
 */
export function unseenRows(rows: JsonObject[], seen: Set<string>): JsonObject[] {
	return rows.filter((row) => {
		const id = stringAt(row, 'id');
		return id === undefined || !seen.has(id);
	});
}

/**
 * The index of the pass this execution is on.
 *
 * On a normal execution `getExecuteData()` carries it. When the node runs as an
 * AI tool the context is n8n's supply-data shape, whose type does not include
 * `getExecuteData` at all — so calling it blind throws a TypeError before any
 * `?.` on the result could help. It is feature-detected instead.
 *
 * `getNextRunIndex()`, which that context offers in its place, is deliberately
 * NOT used as a fallback: it reports where the next run would go, which is not
 * guaranteed to be the same value when n8n retries this step, and an unstable
 * component in the idempotency key would submit — and bill — a second job on
 * every retry. Falling back to 0 is safe because the submission fingerprint,
 * not the run index, is what separates two different requests.
 */
export function currentRunIndex(context: IExecuteFunctions): number {
	const readExecuteData = Reflect.get(context, 'getExecuteData');
	if (typeof readExecuteData !== 'function') return 0;

	try {
		return readNumber(readExecuteData.call(context), 'runIndex') ?? 0;
	} catch {
		return 0;
	}
}

/**
 * Reads a Resource Locator parameter down to the identifier it points at.
 *
 * A workflow saved before the parameter became a locator stores a plain string.
 * Asking n8n to extract a value from that is at best a no-op, so extraction is
 * only requested when there is a locator object to extract from.
 */
export function readLocator(context: IExecuteFunctions, name: string, itemIndex: number): unknown {
	const raw = context.getNodeParameter(name, itemIndex, '');
	if (typeof raw !== 'object' || raw === null) return raw;
	return context.getNodeParameter(name, itemIndex, '', { extractValue: true });
}

/**
 * Reads a Create parameter that moved into the 'Options' collection in 0.5.0.
 *
 * Wait for Completion, Poll Interval, Max Wait, Callback URL, Callback Headers
 * and Idempotency Key used to sit at the top of the panel. Moving them into a
 * collection changes WHERE n8n stores them: a workflow saved on 0.3.0 or 0.4.0
 * has `maxWait` at the top level, a workflow built on 0.5.0 has it under
 * `options`. Both have to keep working, so this reads the new location first
 * and falls back to the old one.
 *
 * Absence in the collection is the signal to fall back, and it is reliable: a
 * collection only stores the keys the user actually added, so a key that is
 * there was set deliberately. That also makes the precedence right for a
 * half-migrated workflow, where the user has added one option and left the rest
 * where they were.
 *
 * The fallback works even though the old parameters are no longer declared,
 * because `getNodeParameter` resolves against the saved workflow rather than
 * against this description.
 */
export function readCreateOption<T>(
	context: IExecuteFunctions,
	name: string,
	itemIndex: number,
	fallback: T,
): T | unknown {
	const options = context.getNodeParameter('options', itemIndex, {});
	if (typeof options === 'object' && options !== null && !Array.isArray(options) && name in options) {
		return (options as Record<string, unknown>)[name];
	}
	return context.getNodeParameter(name, itemIndex, fallback);
}

/** Raises the n8n error for a parameter the user has to correct. */
function invalidParameter(
	node: INode,
	displayName: string,
	what: string,
	how: string,
	itemIndex: number,
): NodeOperationError {
	const message = withItemMarker(`'${displayName}' ${what}`, itemIndex);
	return rememberFailure(new NodeOperationError(node, message, { description: how, itemIndex }), {
		message,
		description: how,
		code: 'PARAMETER_INVALID',
		retryable: false,
	});
}

function requireIdentifier(
	node: INode,
	value: unknown,
	displayName: string,
	itemIndex: number,
): string {
	const identifier = toIdentifier(value);
	if (identifier !== '') return identifier;
	throw invalidParameter(
		node,
		displayName,
		'is empty',
		`Pick a value from the list, or supply one with an expression, then run the workflow again.`,
		itemIndex,
	);
}

/**
 * Drops the mapped parameters n8n marks as unfilled.
 *
 * `null` is the resource mapper's own word for a field the user left empty —
 * it is what n8n writes for one, and what its editor prunes before saving. A
 * workflow assembled anywhere else, through the REST API or a builder, keeps
 * those nulls, and Rendobar refuses a null where it expects a number. Every
 * other value belongs to the user and goes out untouched, `0` included.
 */
/**
 * Turn ResourceMapper keys back into the parameter names the API expects.
 *
 * The mapper keys rows by the field's `key`, which is unique. The request has to
 * be built from `name`, which is not: `image.generate` has four `steps` fields
 * with different bounds, so their keys are `steps__<digest>`. The contract
 * guarantees `key` is `name` or `name__<digest>` and that no name contains
 * `__`, so the name is recoverable here without fetching the schema again on
 * every submission.
 */
export function paramNamesFromKeys(params: JsonObject): JsonObject {
	const named: JsonObject = {};
	for (const [key, value] of Object.entries(params)) {
		const name = /^(.+)__[0-9a-z]+$/.exec(key)?.[1] ?? key;
		// Only one branch's fields are ever filled in, so a collision here would
		// mean the form offered two variants at once. Last value wins, matching
		// what the mapper itself would have done.
		named[name] = value;
	}
	return named;
}

export function providedParams(params: JsonObject): JsonObject {
	const provided: JsonObject = {};
	for (const [name, value] of Object.entries(params)) {
		if (value !== null) provided[name] = value;
	}
	return provided;
}

/**
 * The job's parameters, from whichever of the two editors is on show.
 *
 * The form is built from the flat field list `GET /jobs/types/:type/schema`
 * projects, and a job type whose parameters are a union of shapes has no such
 * projection — the API returns no fields for it, and the form would submit an
 * empty object the API then rejects. 'Using JSON' is the way through, and it
 * also covers any job type added after this node was built.
 *
 * What the form holds is sent as it stands. Deciding here which values look
 * deliberate is not open to us: n8n records nothing that separates a `0` the
 * user typed from one it filled in by itself, and `0` is a real setting for
 * several parameters. Keeping the form from acquiring a value nobody chose is
 * `getJobFields`'s job instead.
 */
/**
 * The media the job reads, from whichever half of the form is showing.
 *
 * The field form is built from the API's inputs descriptor, so an untouched
 * optional input arrives as an empty string and must be dropped rather than
 * sent: an empty `subtitles` would override the auto-extraction that omitting
 * it selects. An empty list is dropped for the same reason.
 */
function readInputs(this: IExecuteFunctions, node: INode, itemIndex: number): JsonObject {
	if (toIdentifier(this.getNodeParameter('inputsMode', itemIndex, 'fields')) !== 'json') {
		const mapped = readObject(this.getNodeParameter('inputFields', itemIndex, {}), 'value') ?? {};
		const inputs: JsonObject = {};
		for (const [name, value] of Object.entries(mapped)) {
			if (value === undefined || value === null || value === '') continue;
			if (Array.isArray(value) && value.length === 0) continue;
			inputs[name] = value;
		}
		return inputs;
	}

	const parsed = readJsonParameter(this.getNodeParameter('inputs', itemIndex, {}));
	if (parsed.ok) return parsed.value;

	throw invalidParameter(
		node,
		'Inputs (JSON)',
		parsed.reason === 'unparsable' ? 'is not valid JSON' : 'is not a JSON object',
		'Give it a JSON object keyed by input name, for example { "source": "https://example.com/video.mp4" }.',
		itemIndex,
	);
}

function readParams(this: IExecuteFunctions, node: INode, itemIndex: number): JsonObject {
	if (toIdentifier(this.getNodeParameter('paramsMode', itemIndex, 'fields')) !== 'json') {
		return providedParams(
			paramNamesFromKeys(readObject(this.getNodeParameter('params', itemIndex, {}), 'value') ?? {}),
		);
	}

	const parsed = readJsonParameter(this.getNodeParameter('paramsJson', itemIndex, {}));
	if (parsed.ok) return parsed.value;

	throw invalidParameter(
		node,
		'Parameters (JSON)',
		parsed.reason === 'unparsable' ? 'is not valid JSON' : 'is not a JSON object',
		'Give it a JSON object of the job type\'s settings, for example { "command": "-i {{source}} -c:v libx264 {{output}}" }. The parameter reference for each job type is at https://rendobar.com/docs.',
		itemIndex,
	);
}

// ── Waiting ───────────────────────────────────────────────────────────────

// Poll GET /jobs/:id until the job reaches a terminal state or maxWait elapses.
// Rendobar has no server-side wait endpoint and CF Workers can't hold a long
// connection, so this polls client-side. It blocks the workflow, so it's meant
// for short jobs; long jobs should use the Rendobar Trigger node instead.
async function waitForJob(
	this: IExecuteFunctions,
	jobId: string,
	pollMs: number,
	maxWaitMs: number,
	itemIndex: number,
): Promise<JsonObject> {
	const deadline = Date.now() + maxWaitMs;

	for (;;) {
		const response = await rendobarApiRequest.call(
			this,
			{ method: 'GET', path: `/jobs/${encodeURIComponent(jobId)}`, idempotent: true },
			itemIndex,
		);
		const job = unwrapData(response) ?? {};
		const status = stringAt(job, 'status');

		if (status === 'failed') {
			throw apiError(this.getNode(), failureFromJob(job, jobId), job, itemIndex);
		}

		if (status !== undefined && TERMINAL_STATUSES.has(status)) return job;

		if (Date.now() >= deadline) {
			const seconds = Math.round(maxWaitMs / 1000);
			const message = withItemMarker(
				`Job ${jobId} is still running after the ${seconds}s allowed by 'Max Wait (Seconds)'`,
				itemIndex,
			);
			const description =
				"For a job this long, set 'Callback URL' to the resume URL of a Wait node placed after this one. n8n then parks the execution and picks it up when the job ends, with no worker held open and no ceiling to raise. Otherwise raise 'Max Wait (Seconds)', or collect the job later with the Get operation.";

			throw rememberFailure(
				new NodeOperationError(this.getNode(), message, { itemIndex, description }),
				{ message, description, code: 'WAIT_EXPIRED', retryable: true, jobId },
			);
		}

		// Sleeping a full interval past the deadline would overshoot
		// 'Max Wait (Seconds)' by up to one poll.
		await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
	}
}

// ── Downloading ───────────────────────────────────────────────────────────

/**
 * The headline output file of a job, when it produced one.
 *
 * `file` comes straight from the API's unified output contract, so it is either
 * a file or null. It is read off the job rather than off the item, which may
 * have been narrowed by Output. Read in two places — the optional download on
 * Get, and the Download Output operation, which has to refuse when there is no
 * file rather than hand back an item with nothing on it.
 */
export function headlineOutputFile(job: JsonObject): JsonObject | undefined {
	const file = objectAt(objectAt(job, 'output'), 'file');
	return stringAt(file, 'url') === undefined ? undefined : file;
}

/**
 * The stop for a Download Output that has nothing to download.
 *
 * `retryable` follows the job's status rather than being fixed: a job still on
 * its way to a result may well have a file on the next pass, while a job that
 * computes data rather than a file never will, however many times it is asked.
 */
export function noOutputFile(
	node: INode,
	job: JsonObject,
	jobId: string,
	itemIndex: number,
): Error {
	const status = stringAt(job, 'status');
	const message = withItemMarker(`Job ${jobId} has no output file to download`, itemIndex);
	// The status is deliberately not quoted into this line. Rendobar's own word
	// for a stopped job is one the n8n copy guidelines rule out of a message, and
	// the three reasons below cover every state anyway. The Get operation shows
	// which one applies.
	const description =
		"A file is on a job once it has completed and produced one. A job still on its way to a result has none yet. A job type that computes data rather than a file, such as ffprobe, never produces one at all and puts its result under 'data' instead. And a job whose retention window has passed has had its files removed. Run the Get operation on the same job to see which of those this is.";

	return rememberFailure(new NodeOperationError(node, message, { itemIndex, description }), {
		message,
		description,
		code: 'NO_OUTPUT_FILE',
		retryable: status === undefined || !TERMINAL_STATUSES.has(status),
		jobId,
	});
}

/**
 * The execution log a job left behind, or an empty list when it left none.
 *
 * `GET /jobs/:id/logs` answers 404 for a job with no logs, which is not a stop:
 * a job that never reached a runner reported nothing, and a job whose retention
 * window has passed had its logs swept along with its files while the flag on
 * the job stayed set. Both are "there are none", and an empty list says so
 * without ending the workflow at exactly the point someone is trying to find
 * out why a job stopped. A 404 naming the job itself cannot arrive here — the
 * caller has already read the job, so the job exists.
 */
export async function readJobLogs(
	this: IExecuteFunctions,
	jobId: string,
	itemIndex: number,
): Promise<JsonValue[]> {
	const response = await rendobarRequest.call(this, {
		method: 'GET',
		path: `/jobs/${encodeURIComponent(jobId)}/logs`,
		idempotent: true,
	});

	if (response.statusCode >= 200 && response.statusCode < 300) {
		return arrayAt(response.body, 'data') ?? [];
	}
	if (response.statusCode === 404) return [];

	throw apiError(
		this.getNode(),
		failureFromResponse(response.statusCode, response.body, jobId),
		response.body,
		itemIndex,
	);
}

/** Streams the headline output file onto the item, without buffering it. */
async function attachOutputFile(
	this: IExecuteFunctions,
	item: INodeExecutionData,
	job: JsonObject,
	binaryProperty: string,
	itemIndex: number,
): Promise<void> {
	const file = headlineOutputFile(job);
	const url = stringAt(file, 'url');
	if (url === undefined) return;

	// `encoding: 'stream'` hands back the response body as it arrives, and
	// `prepareBinaryData` writes it straight to n8n's binary store. Buffering it
	// instead would put the whole file — up to the plan's 10 GB input ceiling —
	// on the heap and defeat the filesystem-backed binary mode.
	const response = (await this.helpers.httpRequest({
		method: 'GET',
		url,
		encoding: 'stream',
		timeout: TRANSFER_TIMEOUT_MS,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		// The URL is presigned and carries its own authorization, so the Rendobar
		// credential must not travel with it.
	})) as { statusCode: number; body: BinaryPayload };

	if (response.statusCode < 200 || response.statusCode >= 300) {
		// The body is an open stream even on a rejection. Leaving it dangling
		// holds the socket until the process notices, so it is closed here before
		// the throw unwinds.
		if (!Buffer.isBuffer(response.body)) response.body.destroy();

		const jobId = stringAt(job, 'id') ?? 'this job';
		const details = failureFromResponse(response.statusCode, null);
		// A rejection means the link is spent; a stall on the storage side is
		// transient and worth simply running again. `retryable` already reflects
		// which one this is, so the advice should match it.
		const transient = response.statusCode >= 500;
		throw apiError(
			this.getNode(),
			{
				...details,
				message: `The output file link for ${jobId} did not open`,
				description: transient
					? 'The storage behind Rendobar did not answer. Run the workflow again in a moment.'
					: 'Output links are time limited. Run the Get operation again to obtain a fresh link, then download it.',
				code: transient ? 'OUTPUT_LINK_UNAVAILABLE' : 'OUTPUT_LINK_EXPIRED',
			},
			null,
			itemIndex,
		);
	}

	item.binary = {
		[binaryProperty]: await this.helpers.prepareBinaryData(
			response.body,
			stringAt(file, 'path'),
		),
	};
}

export class Rendobar implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Rendobar',
		name: 'rendobar',
		icon: { light: 'file:../../icons/rendobar.svg', dark: 'file:../../icons/rendobar.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Submit, track and cancel Rendobar media processing jobs, fetch their output and logs, and read the account balance',
		defaults: { name: 'Rendobar' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'rendobarApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Account',
						value: 'account',
					},
					{
						name: 'File',
						value: 'file',
					},
					{
						name: 'Job',
						value: 'job',
					},
				],
				default: 'job',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['job'] } },
				options: [
					{
						name: 'Cancel',
						value: 'cancel',
						action: 'Cancel job',
						description: 'Stop a job that has not finished yet',
					},
					{
						name: 'Create',
						value: 'create',
						action: 'Create job',
						description: 'Submit a new media processing job',
					},
					{
						name: 'Download Output',
						value: 'download',
						action: 'Download job output',
						description: 'Fetch the file a finished job produced onto the item',
					},
					{
						name: 'Get',
						value: 'get',
						action: 'Get job',
						description: 'Retrieve a job with its status and result',
					},
					{
						name: 'Get Logs',
						value: 'getLogs',
						action: 'Get job logs',
						description: 'Retrieve what the runner recorded while the job ran',
					},
					{
						name: 'Get Many',
						value: 'getAll',
						action: 'Get many jobs',
						description: 'Retrieve a list of jobs, newest first',
					},
				],
				default: 'create',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['file'] } },
				options: [
					{
						name: 'Upload',
						value: 'upload',
						action: 'Upload file',
						description: 'Send a file from a previous node and get a URL to use as a job input',
					},
				],
				default: 'upload',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['account'] } },
				options: [
					{
						// `getAccount` rather than `get`, because `execute` dispatches on
						// the operation alone and two resources sharing a value would send
						// one to the other's branch.
						name: 'Get',
						value: 'getAccount',
						action: 'Get account',
						description:
							'Retrieve the credit balance, plan limits and spend so far this period',
					},
				],
				default: 'getAccount',
			},
			{
				displayName: 'Job Type',
				name: 'jobType',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				displayOptions: { show: { resource: ['job'], operation: ['create'] } },
				description: 'The job type to run. The list is discovered live from your account.',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: { searchListMethod: 'getJobTypes', searchable: true },
					},
					{
						displayName: 'By Name',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. ffmpeg',
					},
				],
			},
			{
				displayName: 'Specify Inputs',
				name: 'inputsMode',
				type: 'options',
				noDataExpression: true,
				default: 'fields',
				displayOptions: { show: { resource: ['job'], operation: ['create'] } },
				description: 'How to give the job the media it reads',
				options: [
					{
						name: 'Using Fields Below',
						value: 'fields',
						description: "Fill in a field per input, built from the job type's own contract",
					},
					{
						name: 'Using JSON',
						value: 'json',
						description:
							'Write the whole inputs object yourself, for ffmpeg and ffprobe which name their files in the command',
					},
				],
			},
			{
				displayName: 'Input Media',
				name: 'inputFields',
				type: 'resourceMapper',
				noDataExpression: true,
				default: { mappingMode: 'defineBelow', value: null },
				required: true,
				displayOptions: {
					show: { resource: ['job'], operation: ['create'], inputsMode: ['fields'] },
				},
				typeOptions: {
					loadOptionsDependsOn: ['jobType.value'],
					resourceMapper: {
						resourceMapperMethod: 'getJobInputFields',
						mode: 'map',
						fieldWords: { singular: 'input', plural: 'inputs' },
						addAllFields: true,
						multiKeyMatch: false,
						supportAutoMap: false,
					},
				},
			},
			{
				displayName: 'Inputs (JSON)',
				name: 'inputs',
				type: 'json',
				default: '{}',
				displayOptions: {
					show: { resource: ['job'], operation: ['create'], inputsMode: ['json'] },
				},
				placeholder: 'e.g. { "source": "https://example.com/video.mp4" }',
				description:
					'The files the job reads, as a JSON object keyed by input name. Each value is a publicly reachable URL, or the URL an Upload returned.',
			},
			{
				displayName: 'Specify Parameters',
				name: 'paramsMode',
				type: 'options',
				noDataExpression: true,
				default: 'fields',
				displayOptions: { show: { resource: ['job'], operation: ['create'] } },
				description: 'How to give the job its settings',
				options: [
					{
						name: 'Using Fields Below',
						value: 'fields',
						description: 'Fill in a form built from the job type\'s own schema',
					},
					{
						name: 'Using JSON',
						value: 'json',
						description:
							'Write the whole parameter object yourself, for job types whose settings have no single form',
					},
				],
			},
			{
				displayName: 'Parameters',
				name: 'params',
				type: 'resourceMapper',
				noDataExpression: true,
				default: { mappingMode: 'defineBelow', value: null },
				displayOptions: {
					show: { resource: ['job'], operation: ['create'], paramsMode: ['fields'] },
				},
				description: "The settings for the chosen job type, loaded live from 'Job Type'",
				typeOptions: {
					loadOptionsDependsOn: ['jobType.value'],
					resourceMapper: {
						resourceMapperMethod: 'getJobFields',
						mode: 'add',
						fieldWords: { singular: 'parameter', plural: 'parameters' },
						addAllFields: true,
						supportAutoMap: false,
					},
				},
			},
			{
				displayName: 'Parameters (JSON)',
				name: 'paramsJson',
				type: 'json',
				default: '{}',
				displayOptions: {
					show: { resource: ['job'], operation: ['create'], paramsMode: ['json'] },
				},
				placeholder: 'e.g. { "schemaVersion": "1.0", "prompt": "a 15 second product tour" }',
				description:
					"The settings for the chosen job type, as a JSON object. Use this for job types whose settings are a choice between shapes, such as Compose, Image Generate and Image Edit, and for anything the form cannot express. See the parameter reference at https://rendobar.com/docs.",
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['job'], operation: ['create'] } },
				// No description on purpose. n8n's own collections carry none, because
				// the placeholder and the child fields already say what this is, and a
				// description here would be the restate-the-label filler the copy rules
				// warn about.
				options: [
				{
					displayName: 'Callback Headers',
					name: 'callbackHeaders',
					type: 'fixedCollection',
					typeOptions: { multipleValues: true },
					default: {},
					placeholder: 'Add Header',
					description:
						"Headers to send with the callback, so the receiver can tell a genuine call apart from anything else that finds the address. On a Wait node, match these to its own Header Auth credential. Names beginning with X-Rendobar- are kept for Rendobar's own delivery details.",
					options: [
						{
							displayName: 'Header',
							name: 'header',
							values: [
								{
									displayName: 'Name',
									name: 'name',
									type: 'string',
									default: '',
									placeholder: 'e.g. Authorization',
									description: 'Name of the header to send',
								},
								{
									displayName: 'Value',
									name: 'value',
									type: 'string',
									typeOptions: { password: true },
									default: '',
									description: 'Value to send under that name',
								},
							],
						},
					],
				},
				{
					displayName: 'Callback URL',
					name: 'callbackUrl',
					type: 'string',
					default: '',
					placeholder: 'e.g. {{ $execution.resumeUrl }}',
					description:
						"Where Rendobar sends the finished job. Put a Wait node set to 'On Webhook Call' after this one and use its resume URL here. n8n then parks the execution instead of holding it open, so a job running for hours occupies no worker and needs no polling. Turn 'Wait for Completion' off when you use this. Leave empty to send nothing.",
					hint: "Set the Wait node's HTTP Method to POST, which is not its default, and switch on its 'Limit Wait Time'. Rendobar posts the job on every ending, including one that stopped or was cancelled, but a call it cannot deliver is retried only five times over about five minutes — after that the parked execution has only that limit to release it.",
				},
				{
					displayName: 'Idempotency Key',
					name: 'idempotencyKey',
					type: 'string',
					default: '',
					placeholder: 'e.g. order-4417',
					description:
						'What makes this submission the same submission. Rendobar keeps one job per key, so a repeat under a key it has seen returns the original job instead of charging for a second one. Leave empty and the node builds a key from the execution, the node, the run, the item and the values being submitted, which covers a repeat inside one execution. Set it to tie the job to something of your own that outlives an execution, such as an order number, and give every distinct submission its own value.',
					hint: 'A key is bound to one job for good. Once that job has stopped without producing anything, only a different key can submit again — so if you retry deliberately, make sure this changes, for example by ending it in {{ $runIndex }}.',
				},
				{
					displayName: 'Max Wait (Seconds)',
					name: 'maxWait',
					type: 'number',
					default: 300,
					typeOptions: { minValue: 5 },
					description:
						'How long to keep waiting. Once this passes, the item stops and reports that the job is still running.',
				},
				{
					displayName: 'Poll Interval (Seconds)',
					name: 'pollInterval',
					type: 'number',
					default: 5,
					typeOptions: { minValue: 2 },
					description: 'How often to check the job status while waiting',
				},
				{
					displayName: 'Wait for Completion',
					name: 'waitForCompletion',
					type: 'boolean',
					default: false,
					description:
						"Whether to hold the execution open until the job finishes and return its result. Suits jobs of a few minutes. For anything longer use 'Callback URL' with a Wait node, which parks the execution instead of holding a worker. The two are alternatives: leave this off whenever 'Callback URL' is set, because a call that arrives while this node is polling cannot be answered.",
				},
				],
			},
			{
				displayName: 'Job',
				name: 'jobId',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				displayOptions: {
					show: { resource: ['job'], operation: ['get', 'cancel', 'download', 'getLogs'] },
				},
				description: 'The job to act on',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: { searchListMethod: 'getJobs', searchable: true },
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. job_abc123',
						validation: [
							{
								type: 'regex',
								properties: {
									regex: '^[A-Za-z0-9_-]+$',
									errorMessage: 'Enter a job ID such as job_abc123, or switch to By URL',
								},
							},
						],
					},
					{
						displayName: 'By URL',
						name: 'url',
						type: 'string',
						placeholder: 'e.g. https://app.rendobar.com/jobs/job_abc123',
						extractValue: {
							type: 'regex',
							regex: '^https?://[^/]+/jobs/([A-Za-z0-9_-]+)',
						},
						validation: [
							{
								type: 'regex',
								properties: {
									regex: '^https?://[^/]+/jobs/[A-Za-z0-9_-]+',
									errorMessage:
										'Enter a Rendobar job link such as https://app.rendobar.com/jobs/job_abc123',
								},
							},
						],
					},
				],
			},
			{
				displayName: 'Download Output File',
				name: 'downloadOutput',
				type: 'boolean',
				default: false,
				displayOptions: { show: { resource: ['job'], operation: ['get'] } },
				description:
					'Whether to fetch the headline result file onto the item so the next node can use it directly. Applies only to finished jobs that produced a file.',
			},
			{
				displayName: 'Output Binary Field',
				name: 'outputBinaryProperty',
				type: 'string',
				default: 'data',
				displayOptions: {
					show: { resource: ['job'], operation: ['get'], downloadOutput: [true] },
				},
				placeholder: 'e.g. data',
				description: 'Name of the output field to put the downloaded file in',
			},
			{
				// A second parameter rather than a wider gate on the one above.
				// `displayOptions.show` ANDs its keys, so "Get with the switch on, OR
				// Download Output" cannot be written as one rule, and relaxing the
				// switch out of the rule would leave a field on the Get panel that
				// does nothing whenever the switch is off.
				displayName: 'Output Binary Field',
				name: 'downloadBinaryProperty',
				type: 'string',
				default: 'data',
				displayOptions: { show: { resource: ['job'], operation: ['download'] } },
				placeholder: 'e.g. data',
				description: 'Name of the output field to put the downloaded file in',
			},
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				default: false,
				displayOptions: { show: { resource: ['job'], operation: ['getAll'] } },
				description: 'Whether to return all results or only up to a given limit',
				hint: "Pages are read one after another, so a job created while this runs can shift the later ones. Duplicates are removed, but a job can still slip past the window. Set 'Created Before' under Filters when the list has to be exact.",
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				default: 50,
				typeOptions: { minValue: 1 },
				displayOptions: {
					show: { resource: ['job'], operation: ['getAll'], returnAll: [false] },
				},
				description: 'Max number of results to return',
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['job'], operation: ['getAll'] } },
				options: [
					{
						displayName: 'Client',
						name: 'client',
						type: 'string',
						default: '',
						placeholder: 'e.g. n8n',
						description: 'Only return jobs submitted by this client',
					},
					{
						displayName: 'Created After',
						name: 'from',
						type: 'dateTime',
						default: '',
						description: 'Only return jobs created at or after this time',
					},
					{
						displayName: 'Created Before',
						name: 'to',
						type: 'dateTime',
						default: '',
						description: 'Only return jobs created at or before this time',
					},
					{
						displayName: 'Job Type',
						name: 'type',
						type: 'string',
						default: '',
						placeholder: 'e.g. ffmpeg',
						description: 'Only return jobs of this job type',
					},
					{
						displayName: 'Status',
						name: 'status',
						type: 'options',
						default: 'complete',
						description: 'Only return jobs in this status',
						options: [
							{ name: 'Cancelled', value: 'cancelled' },
							{ name: 'Complete', value: 'complete' },
							{ name: 'Dispatched', value: 'dispatched' },
							{ name: 'Failed', value: 'failed' },
							{ name: 'Running', value: 'running' },
							{ name: 'Waiting', value: 'waiting' },
						],
					},
				],
			},
			{
				displayName: 'Sort',
				name: 'sort',
				type: 'collection',
				placeholder: 'Add Sort Rule',
				default: {},
				displayOptions: { show: { resource: ['job'], operation: ['getAll'] } },
				options: [
					{
						displayName: 'Sort By',
						name: 'sortBy',
						type: 'options',
						default: 'created',
						description: 'The value to order the results by',
						options: [
							{ name: 'Cost', value: 'cost' },
							{ name: 'Created', value: 'created' },
							{ name: 'Duration', value: 'duration' },
						],
					},
					{
						displayName: 'Sort Order',
						name: 'order',
						type: 'options',
						default: 'desc',
						description: 'The direction to order the results in',
						options: [
							{ name: 'Ascending', value: 'asc' },
							{ name: 'Descending', value: 'desc' },
						],
					},
				],
			},
			{
				displayName: 'Input Binary Field',
				name: 'binaryProperty',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: { show: { resource: ['file'], operation: ['upload'] } },
				placeholder: 'e.g. data',
				hint: 'The name of the input field holding the file to send',
				description: 'Name of the field from a previous node that holds the file to send',
			},
			{
				displayName: 'Filename',
				name: 'uploadFilename',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['file'], operation: ['upload'] } },
				placeholder: 'e.g. clip.mp4',
				description:
					"The name to store the file under. Defaults to the name it already carries on the item.",
			},
			{
				displayName: 'Output',
				name: 'output',
				type: 'options',
				default: 'simplified',
				// Hidden on Get Logs: the item there is a log entry, not a job, so both
				// this projection and the field list below would describe the wrong
				// record. Hiding a parameter does not clear it and `getNodeParameter`
				// still hands back whatever was stored, so the safety here is not the
				// hiding: it is that Get Logs builds its own item and never applies
				// either value to it.
				displayOptions: { show: { resource: ['job'] }, hide: { operation: ['getLogs'] } },
				description:
					'How much of the job to put on the item. A raw job carries around 33 fields, which is more than most workflows need and more than an AI agent can usefully read.',
				options: [
					{
						name: 'Raw',
						value: 'raw',
						description: 'Return every field the API sends back',
					},
					{
						name: 'Selected Fields',
						value: 'selected',
						description: 'Return only the fields you pick, plus the job ID',
					},
					{
						name: 'Simplified',
						value: 'simplified',
						description:
							'Return the handful workflows branch on: ID, type, status, cost, result, timings',
					},
				],
			},
			{
				displayName: 'Fields',
				name: 'outputFields',
				type: 'multiOptions',
				default: ['status', 'data', 'file'],
				displayOptions: {
					show: { resource: ['job'], output: ['selected'] },
					hide: { operation: ['getLogs'] },
				},
				description: 'The job fields to return. The job ID is always included.',
				options: JOB_FIELD_OPTIONS,
			},
			{
				displayName: 'Output',
				name: 'assetOutput',
				type: 'options',
				default: 'simplified',
				displayOptions: { show: { resource: ['file'] } },
				description:
					'How much of the stored file to put on the item. A raw record carries 21 fields, most of which describe how Rendobar stores it rather than anything a workflow acts on.',
				options: [
					{
						name: 'Raw',
						value: 'raw',
						description: 'Return every field the API sends back',
					},
					{
						name: 'Selected Fields',
						value: 'selected',
						description: 'Return only the fields you pick, plus the file ID',
					},
					{
						name: 'Simplified',
						value: 'simplified',
						description:
							'Return the handful jobs need: ID, URL, filename, type, size, status, timings',
					},
				],
			},
			{
				displayName: 'Fields',
				name: 'assetOutputFields',
				type: 'multiOptions',
				default: ['url', 'filename', 'sizeBytes'],
				displayOptions: { show: { resource: ['file'], assetOutput: ['selected'] } },
				description: 'The file fields to return. The file ID is always included.',
				options: ASSET_FIELD_OPTIONS,
			},
		],
	};

	methods = {
		listSearch: { getJobTypes, getJobs },
		resourceMapping: { getJobFields, getJobInputFields },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		// Branch on `operation` rather than `resource`: operation values are unique
		// across resources, so workflows saved before the Resource selector existed
		// keep executing unchanged. That uniqueness is what `getAccount` exists for
		// rather than a second `get`, and test/node-description.test.js pins it.
		const operation = toIdentifier(this.getNodeParameter('operation', 0));
		const executionId = this.getExecutionId();
		const node = this.getNode();
		const runIndex = currentRunIndex(this);
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				// Each resource has its own Output pair, because the field lists behind
				// Selected Fields differ.
				const outputParameter = operation === 'upload' ? 'assetOutput' : 'output';
				const fieldsParameter = operation === 'upload' ? 'assetOutputFields' : 'outputFields';
				const outputMode = toOutputMode(this.getNodeParameter(outputParameter, i, 'simplified'));
				const outputFields =
					outputMode === 'selected'
						? toStringList(this.getNodeParameter(fieldsParameter, i, []))
						: [];

				// Read for every operation, applied only by the ones that emit a job or
				// an asset. Get Logs and the Account resource build their own item, so
				// a value left behind by an earlier operation cannot reach them.
				if (operation === 'getAccount') {
					// One operation, and it reads state rather than usage. The asymmetry
					// worth closing is that `balance.depleted` and `balance.low` can start
					// a workflow which then cannot ask how low: `GET /billing/state`
					// answers that and carries the plan limits a submission can be checked
					// against, while `GET /billing/usage` carries no balance at all and
					// answers a reporting question — a per-job-type map plus one row per
					// date and job type, growing with the account's history. That is a
					// chart rather than something a workflow branches on, and Custom API
					// Call already reaches it.
					const account = await rendobarApiRequest.call(
						this,
						{ method: 'GET', path: '/billing/state', idempotent: true },
						i,
					);
					returnData.push({ json: unwrapData(account) ?? {}, pairedItem: { item: i } });
					continue;
				}

				if (operation === 'getLogs') {
					const jobId = requireIdentifier(node, readLocator(this, 'jobId', i), 'Job', i);

					// The job is read first, and not for decoration. `GET /jobs/:id/logs`
					// answers 404 both for a job that does not exist and for a job that has
					// no logs, and the only thing separating them is the sentence in the
					// body — so reading the job settles it structurally instead. A job ID
					// nobody meant to type stops the item here, with the copy that fits; a
					// job with nothing to show hands back an empty list, which is what
					// someone reacting to `job.failed` needs rather than a stop.
					const response = await rendobarApiRequest.call(
						this,
						{ method: 'GET', path: `/jobs/${encodeURIComponent(jobId)}`, idempotent: true },
						i,
					);
					const job = unwrapData(response) ?? {};

					// `logsAvailable` is the API's own flag for whether a runner ever
					// reported any, so a definite `false` saves the second call outright.
					// It is not trusted the other way: anything else asks, and an absent
					// flag then costs a 404 rather than silently reporting a job's logs as
					// empty.
					const logs =
						booleanAt(job, 'logsAvailable') === false
							? []
							: await readJobLogs.call(this, jobId, i);

					returnData.push({
						json: { jobId, status: stringAt(job, 'status') ?? null, logs },
						pairedItem: { item: i },
					});
					continue;
				}

				if (operation === 'getAll') {
					const returnAll = this.getNodeParameter('returnAll', i, false) === true;
					const limit = returnAll
						? Infinity
						: toWholeNumber(this.getNodeParameter('limit', i, 50), 50, 1);

					const filters = this.getNodeParameter('filters', i, {});
					const sort = this.getNodeParameter('sort', i, {});

					// Read raw rather than as a string: an expression can resolve a date
					// filter to a number of milliseconds, and narrowing to string first
					// would drop it without a word.
					const readDate = (name: string, displayName: string): number | undefined => {
						const raw = readValue(filters, name);
						if (raw === undefined || raw === null || raw === '') return undefined;

						const parsed = readUnixMs(raw);
						if (parsed !== undefined) return parsed;

						throw invalidParameter(
							node,
							displayName,
							'is not a date n8n could read',
							'Pick a date from the calendar, or supply an ISO 8601 timestamp such as 2026-08-19T09:00:00Z.',
							i,
						);
					};

					const createdAfter = readDate('from', 'Created After');
					const createdBefore = readDate('to', 'Created Before');

					const query: Record<string, string | number> = {};
					const client = readString(filters, 'client');
					const type = readString(filters, 'type');
					const status = readString(filters, 'status');
					if (client !== undefined) query.client = client;
					if (type !== undefined) query.type = type;
					if (status !== undefined) query.status = status;
					if (createdAfter !== undefined) query.from = createdAfter;
					if (createdBefore !== undefined) query.to = createdBefore;
					const sortBy = readString(sort, 'sortBy');
					const order = readString(sort, 'order');
					if (sortBy !== undefined) query.sort = sortBy;
					if (order !== undefined) query.order = order;

					let offset = 0;
					let taken = 0;
					// Every job ID already pushed, so a row that two offset pages both
					// claim is returned once. Bounded by what `returnData` already holds.
					const seen = new Set<string>();
					for (;;) {
						const pageSize = Math.min(
							MAX_PAGE_SIZE,
							limit === Infinity ? MAX_PAGE_SIZE : limit - taken,
						);
						const page = await rendobarApiRequest.call(
							this,
							{
								method: 'GET',
								path: '/jobs',
								qs: { ...query, limit: pageSize, offset },
								idempotent: true,
							},
							i,
						);
						// Paging is driven by the raw row count, not by how many rows
						// survived narrowing: a row the API sent that is not an object
						// still occupies an offset slot, so counting only the usable ones
						// would re-request it on the next page and read it twice.
						const rows = arrayAt(page, 'data') ?? [];
						const jobs = unseenRows(rows.filter(isJsonObject), seen);

						const room = roomFor(limit, taken, jobs.length);
						for (const job of jobs.slice(0, room)) {
							const id = stringAt(job, 'id');
							if (id !== undefined) seen.add(id);
							returnData.push(buildJobItem(job, i, outputMode, outputFields));
						}
						taken += room;

						offset += rows.length;
						const total = numberAt(objectAt(page, 'meta'), 'total');
						if (pageExhausted(rows.length, pageSize, offset, total) || taken >= limit) break;
					}

					continue;
				}

				let job: JsonObject;
				// Named outside the branch below so the Download Output stop can quote
				// the job the user asked for, whatever the response turned out to hold.
				let jobIdentifier = '';

				if (operation === 'create') {
					const jobType = requireIdentifier(
						node,
						readLocator(this, 'jobType', i),
						'Job Type',
						i,
					);

					const media = readInputs.call(this, node, i);

					const callback = buildCallback(
						readCreateOption(this, 'callbackUrl', i, ''),
						readCreateOption(this, 'callbackHeaders', i, {}),
					);
					if (!callback.ok) {
						throw invalidParameter(node, callback.parameter, callback.what, callback.how, i);
					}

					const waitForCompletion = readCreateOption(this, 'waitForCompletion', i, false) === true;

					// Before the submission, not after: a job submitted under a pairing
					// whose result can never be collected is a job billed for nothing.
					const clash = waitAndCallbackConflict(callback.callback !== undefined, waitForCompletion);
					if (clash !== undefined) {
						throw invalidParameter(node, clash.parameter, clash.what, clash.how, i);
					}

					const submission: JsonObject = {
						type: jobType,
						inputs: media,
						params: readParams.call(this, node, i),
						// Part of the submission, and so part of the fingerprint behind the
						// idempotency key: two jobs that differ only in where the result is
						// delivered are two different requests, and `POST /jobs` registers
						// the callback only for a freshly admitted job.
						...(callback.callback === undefined ? {} : { callback: callback.callback }),
					};

					// The key has to be stable across n8n's retry of this step (so a
					// transient stall doesn't charge twice) AND different for every
					// distinct submission. `POST /jobs` looks a repeated key up on
					// (org, key) alone and never compares payloads, so a colliding key
					// silently hands back the FIRST job instead of refusing.
					//
					// Execution, node, run and item separate the ordinary cases: two
					// Rendobar nodes in one workflow, the passes of a Loop Over Items,
					// and the items of one pass. They are not enough on their own,
					// because this node is `usableAsTool`: an agent calling it twice in
					// one execution can present the same execution, node, run and item
					// for two completely different requests, and the second would come
					// back as the first job's result with its own parameters discarded.
					//
					// The fingerprint closes that: different requests fingerprint
					// differently, while a retry of the same request rebuilds the same
					// submission and so keeps the same key. Two genuinely identical
					// requests still collapse onto one job, which is the behaviour
					// idempotency is for.
					//
					// Every component of that is stable inside one execution, which is
					// deliberate and is also why it cannot be the whole answer: a
					// DELIBERATE retry of the same submission rebuilds the same key, and
					// Rendobar refuses a key whose job stopped without ever running.
					// The 'Idempotency Key' parameter is the lever for that, and
					// submitJob walks off a key the node picked itself once Rendobar
					// says it is spent.
					const chosenKey = toIdentifier(readCreateOption(this, 'idempotencyKey', i, ''));
					const idempotencyKey =
						chosenKey === ''
							? `n8n:${executionId}:${node.id}:${runIndex}:${i}:${fingerprint(submission)}`
							: chosenKey;

					const created = await submitJob.call(
						this,
						submission,
						idempotencyKey,
						// The node may replace a key it invented. It must not invent a
						// variant of one the user asserted: a key set by hand is a promise
						// about which submissions are the same submission, and only its
						// author knows what changing it would mean. That conflict is
						// reported, with the copy that names this parameter.
						chosenKey === '' ? spentKeyBudget(node) : 1,
						i,
					);

					job = unwrapData(created) ?? {};

					if (waitForCompletion) {
						const status = stringAt(job, 'status');
						const jobId = stringAt(job, 'id');
						if (jobId === undefined) {
							// Waiting was asked for and cannot be done, so say so rather than
							// handing back a job that has not finished as though it had.
							throw invalidParameter(
								node,
								'Wait for Completion',
								'cannot be honoured because Rendobar did not name the submitted job',
								'Turn it off and collect the job with the Get operation, or run the workflow again.',
								i,
							);
						}
						if (status === undefined || !TERMINAL_STATUSES.has(status)) {
							const pollMs = toWholeNumber(readCreateOption(this, 'pollInterval', i, 5), 5, 1) * 1000;
							const maxWaitMs =
								toWholeNumber(readCreateOption(this, 'maxWait', i, 300), 300, 1) * 1000;
							job = await waitForJob.call(this, jobId, pollMs, maxWaitMs, i);
						}
					}
				} else if (operation === 'upload') {
					const binaryProperty = toIdentifier(this.getNodeParameter('binaryProperty', i, 'data'));
					// Raises n8n's own message naming the field when the item has no file.
					const binary = this.helpers.assertBinaryData(i, binaryProperty);
					const source = await binaryUploadSource(this, i, binaryProperty, binary);
					const filename =
						toIdentifier(this.getNodeParameter('uploadFilename', i, '')) ||
						binary.fileName ||
						'upload';

					const uploaded = await rendobarUpload.call(
						this,
						source,
						filename,
						binary.mimeType || 'application/octet-stream',
						i,
					);
					returnData.push(
						buildAssetItem(unwrapData(uploaded) ?? {}, i, outputMode, outputFields),
					);
					continue;
				} else {
					const jobId = requireIdentifier(
						node,
						readLocator(this, 'jobId', i),
						'Job',
						i,
					);
					jobIdentifier = jobId;
					const path = `/jobs/${encodeURIComponent(jobId)}`;
					const response = await rendobarApiRequest.call(
						this,
						operation === 'cancel'
							? // Cancelling an already-cancelled job settles to the same state.
								{ method: 'POST', path: `${path}/cancel`, idempotent: true }
							: { method: 'GET', path, idempotent: true },
						i,
					);
					job = unwrapData(response) ?? {};
				}

				const item = buildJobItem(job, i, outputMode, outputFields);

				// Both routes to a file go through `attachOutputFile`, which streams the
				// response into n8n's binary store and closes it when the link answers a
				// non-2xx. What separates them is what a missing file means.
				//
				// On Get the file is an extra, so a job that produced none simply arrives
				// without one. On Download Output the file IS the operation, so the same
				// silence would hand back an item that looks like a download and carries
				// nothing.
				if (operation === 'download') {
					if (headlineOutputFile(job) === undefined) {
						throw noOutputFile(node, job, stringAt(job, 'id') ?? jobIdentifier, i);
					}
					await attachOutputFile.call(
						this,
						item,
						job,
						toIdentifier(this.getNodeParameter('downloadBinaryProperty', i, 'data')) || 'data',
						i,
					);
				} else if (
					operation === 'get' &&
					this.getNodeParameter('downloadOutput', i, false) === true
				) {
					await attachOutputFile.call(
						this,
						item,
						job,
						toIdentifier(this.getNodeParameter('outputBinaryProperty', i, 'data')) || 'data',
						i,
					);
				}

				returnData.push(item);
			} catch (error) {
				// One shape for every operation: the message n8n would have shown,
				// plus the fields an If or Switch node can route on.
				const details = describeFailure(error);

				if (this.continueOnFail()) {
					returnData.push({ json: failureItemJson(details), pairedItem: { item: i } });
					continue;
				}

				// Every branch above already raises a well-formed n8n error, and
				// re-wrapping one would bury its message. Anything else reaching here
				// is a defect in this node rather than an answer from Rendobar.
				throw error instanceof NodeApiError || error instanceof NodeOperationError
					? error
					: new NodeOperationError(node, withItemMarker(details.message, i), {
							itemIndex: i,
							description: details.description ?? 'Run the workflow again.',
						});
			}
		}

		return [returnData];
	}
}
