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

// Derived from shared/output.ts so there is no second hand-kept list. Sorted on
// the label, not the field name, because the overrides above move some of them
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

// Parameter readers. `getNodeParameter` hands back a broad union; these narrow
// one to the value the code needs without asserting an unchecked shape.

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
 * `typeOptions.minValue` only constrains the editor; an expression can still
 * resolve to zero or negative at run time. A poll interval of zero spins against
 * the API and a negative page size reads as "no limit" in SQLite, so the floor is
 * enforced here too.
 */
function toWholeNumber(value: unknown, fallback: number, minimum: number): number {
	const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
	return Math.max(minimum, number);
}

/**
 * Serialises a submission identically whatever order the keys arrive in. n8n
 * rebuilds a resource-mapper value from the stored parameters each run, so
 * insertion order would fingerprint the same submission differently.
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
 * A short, stable fingerprint of a submission. Not a security boundary: it only
 * has to differ between two different submissions, so two FNV-1a-style passes are
 * enough and avoid the `node:crypto` import a verified node may not have.
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
 * The key that replaces one Rendobar reports spent.
 *
 * `POST /jobs` binds a key to one job and keeps the binding after it ends. Once
 * that job has stopped with a retryable code the key can do nothing: no usable
 * job to hand back and no second job to start, so the API answers 409 naming it.
 *
 * Derived from the BASE key, not the previous one, so the chain stays a constant
 * length however many attempts walk it, and from the job ID, not a counter or a
 * random value, so it is a pure function of what Rendobar just said. That is what
 * keeps the guarantee: two deliveries of the SAME attempt see the same 409, build
 * the same replacement and settle on one job, while two different submissions
 * differ in the base key and never meet here.
 */
export function retryKeyFor(baseKey: string, boundJobId: string): string {
	return `${baseKey}~${boundJobId}`;
}

/**
 * How many spent keys one pass of `execute` walks past before reporting the
 * conflict.
 *
 * TRAP: n8n hands a node no attempt number. `execute()` is re-invoked with an
 * identical signature and `this` on every try of Retry On Fail, so nothing
 * distinguishes try 3 from try 1 (checked against n8n-workflow 2.16.0: no
 * `getTryIndex`, nothing per-attempt on `INode`, `IExecuteData`, `ITaskData` or
 * the expression proxy, and `$runIndex` counts loop passes, not tries). What is
 * readable is `maxTries` on the node object.
 *
 * That budget is the right size: try N rebuilds the same base key, so it meets
 * the job try 1 created, then try 2's, one hop per attempt already spent.
 * Anything beyond it is not a case Retry On Fail can produce, and the ceiling
 * stops a hand-edited `maxTries` becoming an unbounded run of submissions. With
 * Retry On Fail off no attempt can be spent, so one try is enough.
 */
export function spentKeyBudget(node: INode): number {
	if (node.retryOnFail !== true) return 1;
	// n8n's own default when Retry On Fail is switched on without touching it.
	const tries = readNumber(node, 'maxTries') ?? 3;
	return Math.min(10, Math.max(1, Math.floor(tries)));
}

/**
 * Submits one job, moving off an idempotency key Rendobar reports spent.
 *
 * `rendobarRequest` rather than `rendobarApiRequest` because the 409 is data
 * before it is a stop: the key is bound to a job that stopped without reaching a
 * runner, so no resubmission under it is possible. Moving off duplicates nothing,
 * since that job produced no result and is over, so the retry is granted under
 * {@link retryKeyFor} rather than reported.
 *
 * `budget` caps it at one attempt per key the caller could plausibly have spent.
 * Past that, or on any other conflict, the response is raised with the copy in
 * ./shared/failure.
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
			// Safe to repeat: the key makes a second delivery of THIS attempt settle
			// on the job the first created.
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
 * How many of a page's usable rows fit inside 'Limit'. The server is expected to
 * honour it, but the surplus is dropped here if it ever clamps or ignores it.
 */
export function roomFor(limit: number, taken: number, available: number): number {
	if (limit === Infinity) return available;
	return Math.min(available, Math.max(0, limit - taken));
}

/**
 * Whether the last page ended the list.
 *
 * `rowCount` is how many rows the API sent, NOT how many survived narrowing. A
 * non-object row still occupies an offset slot, so counting only usable rows
 * would re-request it on the next page and would also end a Return All early,
 * since a short page reads as the end.
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
 * The rows of a page not already handed to the workflow.
 *
 * `GET /jobs` pages by offset over creation time with no tiebreaker, and jobs are
 * created inside the same millisecond, so two page queries may order those rows
 * differently and put one in both pages. A job created mid-walk does the same
 * from the other end by pushing every row behind it one slot. This node can only
 * see a job it has already emitted and refuse to emit it twice; a row that moved
 * the other way, out of the window, is not recoverable, which is why the README
 * points at 'Created Before' for a run that has to be exact.
 *
 * `seen` is not written here: the caller adds the IDs it actually emits, so a row
 * trimmed by 'Limit' is not marked delivered. A row whose `id` is not a string is
 * kept, since it cannot be recognised on a later page either way.
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
 * `getExecuteData()` carries it on a normal execution. As an AI tool the context
 * is n8n's supply-data shape, whose type has no `getExecuteData` at all, so
 * calling it blind throws a TypeError before `?.` could help. Feature-detected.
 *
 * `getNextRunIndex()` is NOT used as a fallback: it reports where the next run
 * would go, which is not guaranteed stable across an n8n retry, and an unstable
 * component in the idempotency key would submit and bill a second job every time.
 * Falling back to 0 is safe because the fingerprint, not the run index, separates
 * two different requests.
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
 * A Resource Locator parameter down to the identifier it points at. A workflow
 * saved before the parameter became a locator stores a plain string, so
 * extraction is only requested when there is a locator object.
 */
export function readLocator(context: IExecuteFunctions, name: string, itemIndex: number): unknown {
	const raw = context.getNodeParameter(name, itemIndex, '');
	if (typeof raw !== 'object' || raw === null) return raw;
	return context.getNodeParameter(name, itemIndex, '', { extractValue: true });
}

/**
 * A Create parameter that moved into the 'Options' collection in 0.5.0.
 *
 * Moving a parameter into a collection changes WHERE n8n stores it: a workflow
 * saved on 0.3.0 or 0.4.0 has `maxWait` at the top level, one built on 0.5.0 has
 * it under `options`. Reads the new location first, falls back to the old.
 *
 * Absence in the collection is a reliable fallback signal because a collection
 * stores only the keys the user added, which also gets the precedence right for a
 * half-migrated workflow.
 *
 * The fallback works even though the old parameters are no longer declared,
 * because `getNodeParameter` resolves against the SAVED WORKFLOW, not against
 * this description.
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
 * `null` is the resource mapper's own word for an empty field, and its editor
 * prunes them before saving. A workflow assembled through the REST API or a
 * builder keeps them, and Rendobar refuses a null where it expects a number.
 * Every other value goes out untouched, `0` included.
 */
/**
 * ResourceMapper keys back to the parameter names the API expects.
 *
 * The mapper keys rows by `key`, which is unique; the request is built from
 * `name`, which is not (`image.generate` has four `steps` fields, keyed
 * `steps__<digest>`). The contract guarantees `key` is `name` or `name__<digest>`
 * and that no name contains `__`, so the name is recoverable without refetching
 * the schema.
 */
export function paramNamesFromKeys(params: JsonObject): JsonObject {
	const named: JsonObject = {};
	for (const [key, value] of Object.entries(params)) {
		const name = /^(.+)__[0-9a-z]+$/.exec(key)?.[1] ?? key;
		// Only one branch's fields are ever filled, so a collision would mean the
		// form offered two variants at once. Last value wins, as the mapper would.
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
 * The job's parameters, from whichever editor is showing.
 *
 * The form is built from the flat field list `GET /jobs/types/:type/schema`
 * projects. A job type whose parameters are a union of shapes has no such
 * projection, so the form would submit an empty object the API rejects; 'Using
 * JSON' is the way through and also covers job types added after this release.
 *
 * What the form holds is sent as it stands. n8n records nothing that separates a
 * `0` the user typed from one it filled in itself, and `0` is a real setting for
 * several parameters, so keeping the form from acquiring an unchosen value is
 * `getJobFields`'s job instead.
 */
/**
 * The media the job reads, from whichever half of the form is showing.
 *
 * An untouched optional input arrives as an empty string and must be dropped, not
 * sent: an empty `subtitles` would override the auto-extraction that omitting it
 * selects. An empty list goes the same way.
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

// Waiting

// Polls GET /jobs/:id until the job settles or maxWait elapses. Rendobar has no
// server-side wait endpoint and CF Workers cannot hold a long connection, so this
// is client-side. It blocks the workflow, so long jobs want the trigger instead.
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

// Downloading

/**
 * The headline output file of a job, when it produced one. Read off the job
 * rather than the item, which Output may have narrowed. Used by the optional
 * download on Get and by the Download Output operation.
 */
export function headlineOutputFile(job: JsonObject): JsonObject | undefined {
	const file = objectAt(objectAt(job, 'output'), 'file');
	return stringAt(file, 'url') === undefined ? undefined : file;
}

/**
 * The stop for a Download Output with nothing to download. `retryable` follows
 * the job's status: a job still on its way may have a file next pass, one that
 * computes data rather than a file never will.
 */
export function noOutputFile(
	node: INode,
	job: JsonObject,
	jobId: string,
	itemIndex: number,
): Error {
	const status = stringAt(job, 'status');
	const message = withItemMarker(`Job ${jobId} has no output file to download`, itemIndex);
	// The status is not quoted in: Rendobar's word for a stopped job is one the
	// n8n copy guidelines ban from a message, and the three reasons cover every
	// state. Get shows which applies.
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
 * The execution log a job left, or an empty list when it left none.
 *
 * `GET /jobs/:id/logs` answers 404 for a job with no logs, which is not a stop: a
 * job that never reached a runner reported nothing, and a job past its retention
 * window had its logs swept with its files while the flag stayed set. Both mean
 * "there are none", and an empty list says so without ending the workflow at the
 * point someone is finding out why a job stopped. A 404 for a missing job cannot
 * arrive here, since the caller already read the job.
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

	// `encoding: 'stream'` hands back the body as it arrives and
	// `prepareBinaryData` writes it straight to n8n's binary store. Buffering
	// would put the whole file, up to the plan's 10 GB ceiling, on the heap and
	// defeat the filesystem-backed binary mode.
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
		// The body is an open stream even on a rejection, and a dangling one holds
		// the socket, so it is closed before the throw unwinds.
		if (!Buffer.isBuffer(response.body)) response.body.destroy();

		const jobId = stringAt(job, 'id') ?? 'this job';
		const details = failureFromResponse(response.statusCode, null);
		// A rejection means the link is spent; a storage-side stall is transient.
		// `retryable` already says which, so the advice matches it.
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
						// `getAccount`, not `get`: `execute` dispatches on the operation
						// alone, so two resources sharing a value would cross branches.
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
					'The settings for the chosen job type, as a JSON object. Compose, Image Generate and Image Edit need this, as does anything the form cannot express. See https://rendobar.com/docs.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['job'], operation: ['create'] } },
				// No description: n8n's own collections carry none, and the placeholder
				// and child fields already say what this is.
				options: [
				{
					displayName: 'Callback Headers',
					name: 'callbackHeaders',
					type: 'fixedCollection',
					typeOptions: { multipleValues: true },
					default: {},
					placeholder: 'Add Header',
					description:
						"Headers to send with the callback, so the receiver can check that the call came from Rendobar. Names beginning with X-Rendobar- are reserved.",
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
						"Where Rendobar sends the finished job. Use a Wait node's resume URL here and n8n parks the execution instead of holding a worker open. Turn 'Wait for Completion' off when you use this.",
				},
				{
					displayName: 'Idempotency Key',
					name: 'idempotencyKey',
					type: 'string',
					default: '',
					placeholder: 'e.g. order-4417',
					description:
						'A value that identifies this submission. Rendobar returns the original job for a key it has already seen instead of charging for a second one. Leave empty and the node derives one per item.',
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
						"Whether to hold the execution open until the job finishes and return its result. Suits jobs of a few minutes; for longer ones use 'Callback URL' instead, and leave this off when you do.",
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
				// A second parameter, not a wider gate: `displayOptions.show` ANDs its
				// keys, so "Get with the switch on, OR Download Output" cannot be one
				// rule, and dropping the switch from it would leave a dead field on Get.
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
				// Hidden on Get Logs, whose item is a log entry rather than a job, so
				// this projection and the field list would describe the wrong record.
				// TRAP: hiding does not clear a parameter and `getNodeParameter` still
				// returns it. The safety is that Get Logs builds its own item.
				displayOptions: { show: { resource: ['job'] }, hide: { operation: ['getLogs'] } },
				description:
					'How much of the job to put on the item',
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
					'How much of the stored file to put on the item',
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
		// Branch on `operation`, not `resource`: operation values are unique across
		// resources, so workflows saved before the Resource selector existed keep
		// running. That uniqueness is why `getAccount` is not a second `get`, and
		// test/node-description.test.js pins it.
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

				// Read for every operation, applied only by those emitting a job or an
				// asset. Get Logs and Account build their own item.
				if (operation === 'getAccount') {
					// State, not usage. `balance.depleted` and `balance.low` can start a
					// workflow that then needs to ask how low; `GET /billing/state`
					// answers that and carries the plan limits. `GET /billing/usage`
					// carries no balance and returns a per-job-type map plus one row per
					// date, which is a chart rather than something to branch on. Custom
					// API Call reaches it for anyone who wants it.
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

					// The job is read first because `GET /jobs/:id/logs` answers 404 both
					// for a missing job and for a job with no logs, separated only by the
					// sentence in the body. Reading the job settles it structurally: a bad
					// ID stops here, a job with nothing to show returns an empty list.
					const response = await rendobarApiRequest.call(
						this,
						{ method: 'GET', path: `/jobs/${encodeURIComponent(jobId)}`, idempotent: true },
						i,
					);
					const job = unwrapData(response) ?? {};

					// `logsAvailable` is the API's flag for whether a runner reported any,
					// so a definite `false` skips the second call. Not trusted the other
					// way: anything else asks, and an absent flag costs a 404 rather than
					// silently reporting logs as empty.
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

					// Read raw, not as a string: an expression can resolve a date filter to
					// milliseconds, which narrowing to string would silently drop.
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
					// Every job ID already pushed, so a row two offset pages both claim is
					// returned once.
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
						// Paging is driven by the raw row count: a non-object row still
						// occupies an offset slot, so counting only usable rows would
						// re-request it on the next page.
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
				// Named outside the branch so the Download Output stop can quote the job
				// the user asked for, whatever the response held.
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

					// Before the submission: a job whose result can never be collected is
					// billed for nothing.
					const clash = waitAndCallbackConflict(callback.callback !== undefined, waitForCompletion);
					if (clash !== undefined) {
						throw invalidParameter(node, clash.parameter, clash.what, clash.how, i);
					}

					const submission: JsonObject = {
						type: jobType,
						inputs: media,
						params: readParams.call(this, node, i),
						// Part of the submission, so part of the fingerprint behind the
						// idempotency key: two jobs differing only in delivery address are
						// two requests, and `POST /jobs` registers the callback only for a
						// freshly admitted job.
						...(callback.callback === undefined ? {} : { callback: callback.callback }),
					};

					// The key must be stable across n8n's retry of this step, so a stall
					// does not charge twice, AND different for every distinct submission.
					// TRAP: `POST /jobs` looks a repeated key up on (org, key) alone and
					// never compares payloads, so a colliding key silently returns the
					// FIRST job.
					//
					// Execution, node, run and item cover two nodes in one workflow, the
					// passes of a Loop Over Items, and the items of one pass. Not enough
					// alone: the node is `usableAsTool`, and an agent calling it twice in
					// one execution presents all four identically for two different
					// requests. The fingerprint separates those while a retry of the same
					// request rebuilds the same submission and keeps the same key.
					//
					// Every component is stable inside one execution, so a DELIBERATE
					// retry rebuilds the same key and Rendobar refuses one whose job
					// stopped without running. 'Idempotency Key' is the lever, and
					// submitJob walks off a key the node picked itself.
					const chosenKey = toIdentifier(readCreateOption(this, 'idempotencyKey', i, ''));
					const idempotencyKey =
						chosenKey === ''
							? `n8n:${executionId}:${node.id}:${runIndex}:${i}:${fingerprint(submission)}`
							: chosenKey;

					const created = await submitJob.call(
						this,
						submission,
						idempotencyKey,
						// The node may replace a key it invented, never one the user set: a
						// hand-written key is a statement about which submissions are the
						// same, and only its author knows what changing it means.
						chosenKey === '' ? spentKeyBudget(node) : 1,
						i,
					);

					job = unwrapData(created) ?? {};

					if (waitForCompletion) {
						const status = stringAt(job, 'status');
						const jobId = stringAt(job, 'id');
						if (jobId === undefined) {
							// Waiting was asked for and cannot be done, so say so rather than
							// return an unfinished job as though it had finished.
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

				// Both routes go through `attachOutputFile`. What differs is what a
				// missing file means: on Get it is an extra, so the job arrives without
				// one; on Download Output it IS the operation, so silence would return an
				// item that looks like a download and carries nothing.
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
				// One shape for every operation: the message n8n would have shown, plus
				// the fields an If or Switch node can route on.
				const details = describeFailure(error);

				if (this.continueOnFail()) {
					returnData.push({ json: failureItemJson(details), pairedItem: { item: i } });
					continue;
				}

				// Every branch above raises a well-formed n8n error and re-wrapping would
				// bury its message. Anything else here is a defect in this node.
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
