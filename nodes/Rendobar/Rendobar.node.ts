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
	withItemMarker,
} from './shared/failure';
import {
	numberAt,
	objectAt,
	objectsAt,
	readJsonParameter,
	readObject,
	readString,
	readUnixMs,
	stringAt,
	unwrapData,
	type JsonObject,
} from './shared/json';
import { getJobTypes } from './listSearch/getJobTypes';
import { getJobs } from './listSearch/getJobs';
import { getJobFields } from './methods/getJobFields';
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
				"Raise 'Max Wait (Seconds)', collect the job later with the Get operation, or start the workflow from the Rendobar Trigger node, which reacts to the finished job instead of holding this execution open.";

			throw rememberFailure(
				new NodeOperationError(this.getNode(), message, { itemIndex, description }),
				{ message, description, code: 'WAIT_EXPIRED', retryable: true, jobId },
			);
		}

		await sleep(pollMs);
	}
}

// ── Downloading ───────────────────────────────────────────────────────────

/** Streams the headline output file onto the item, without buffering it. */
async function attachOutputFile(
	this: IExecuteFunctions,
	item: INodeExecutionData,
	job: JsonObject,
	binaryProperty: string,
	itemIndex: number,
): Promise<void> {
	// `file` comes straight from the API's unified output contract, so it is
	// either a file or null. It is read off the job rather than the item, which
	// may have been narrowed by Output.
	const file = objectAt(objectAt(job, 'output'), 'file');
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
		const jobId = stringAt(job, 'id') ?? 'this job';
		const details = failureFromResponse(response.statusCode, null);
		throw apiError(
			this.getNode(),
			{
				...details,
				message: `The output file link for ${jobId} did not open`,
				description:
					'Output links are time limited. Run the Get operation again to obtain a fresh link, then download it.',
				code: 'OUTPUT_LINK_EXPIRED',
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
		description: 'Submit, fetch, and cancel Rendobar media processing jobs',
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
						name: 'Get',
						value: 'get',
						action: 'Get job',
						description: 'Retrieve a job with its status and result',
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
				displayName: 'Inputs (JSON)',
				name: 'inputs',
				type: 'json',
				default: '{}',
				displayOptions: { show: { resource: ['job'], operation: ['create'] } },
				placeholder: 'e.g. { "source": "https://example.com/video.mp4" }',
				description:
					'The files the job reads, as a JSON object keyed by input name. Each value is a publicly reachable URL, or the URL an Upload returned.',
			},
			{
				displayName: 'Parameters',
				name: 'params',
				type: 'resourceMapper',
				noDataExpression: true,
				default: { mappingMode: 'defineBelow', value: null },
				displayOptions: { show: { resource: ['job'], operation: ['create'] } },
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
				displayName: 'Wait for Completion',
				name: 'waitForCompletion',
				type: 'boolean',
				default: false,
				displayOptions: { show: { resource: ['job'], operation: ['create'] } },
				description:
					'Whether to hold the execution open until the job finishes and return its result. Good for short jobs. For long jobs prefer the Rendobar Trigger node, which reacts to the finished job instead.',
			},
			{
				displayName: 'Poll Interval (Seconds)',
				name: 'pollInterval',
				type: 'number',
				default: 5,
				typeOptions: { minValue: 2 },
				displayOptions: {
					show: { resource: ['job'], operation: ['create'], waitForCompletion: [true] },
				},
				description: 'How often to check the job status while waiting',
			},
			{
				displayName: 'Max Wait (Seconds)',
				name: 'maxWait',
				type: 'number',
				default: 300,
				typeOptions: { minValue: 5 },
				displayOptions: {
					show: { resource: ['job'], operation: ['create'], waitForCompletion: [true] },
				},
				description:
					'How long to keep waiting. Once this passes, the item stops and reports that the job is still running.',
			},
			{
				displayName: 'Job',
				name: 'jobId',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				displayOptions: { show: { resource: ['job'], operation: ['get', 'cancel'] } },
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
				displayOptions: { show: { resource: ['job'] } },
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
				displayOptions: { show: { resource: ['job'], output: ['selected'] } },
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
		resourceMapping: { getJobFields },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		// Branch on `operation` rather than `resource`: operation values are unique
		// across resources, so workflows saved before the Resource selector existed
		// keep executing unchanged.
		const operation = toIdentifier(this.getNodeParameter('operation', 0));
		const executionId = this.getExecutionId();
		const node = this.getNode();
		// Present on a normal execution; absent in some tool/partial-execution
		// contexts, where there is only ever one pass anyway.
		const runIndex = this.getExecuteData()?.runIndex ?? 0;
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

				if (operation === 'getAll') {
					const returnAll = this.getNodeParameter('returnAll', i, false) === true;
					const limit = returnAll
						? Infinity
						: toWholeNumber(this.getNodeParameter('limit', i, 50), 50, 1);

					const filters = this.getNodeParameter('filters', i, {});
					const sort = this.getNodeParameter('sort', i, {});

					const createdAfter = readUnixMs(readString(filters, 'from'));
					const createdBefore = readUnixMs(readString(filters, 'to'));
					if (readString(filters, 'from') !== undefined && createdAfter === undefined) {
						throw invalidParameter(
							node,
							'Created After',
							'is not a date n8n could read',
							'Pick a date from the calendar, or supply an ISO 8601 timestamp such as 2026-08-19T09:00:00Z.',
							i,
						);
					}
					if (readString(filters, 'to') !== undefined && createdBefore === undefined) {
						throw invalidParameter(
							node,
							'Created Before',
							'is not a date n8n could read',
							'Pick a date from the calendar, or supply an ISO 8601 timestamp such as 2026-08-19T09:00:00Z.',
							i,
						);
					}

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
					for (;;) {
						const pageSize = Math.min(
							MAX_PAGE_SIZE,
							limit === Infinity ? MAX_PAGE_SIZE : limit - offset,
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
						const jobs = objectsAt(page, 'data');

						for (const job of jobs) {
							returnData.push(buildJobItem(job, i, outputMode, outputFields));
						}

						offset += jobs.length;
						const total = numberAt(objectAt(page, 'meta'), 'total');
						const exhausted =
							jobs.length < pageSize || (total !== undefined && offset >= total);
						if (exhausted || offset >= limit) break;
					}

					continue;
				}

				let job: JsonObject;

				if (operation === 'create') {
					const jobType = requireIdentifier(
						node,
						this.getNodeParameter('jobType', i, '', { extractValue: true }),
						'Job Type',
						i,
					);

					const parsed = readJsonParameter(this.getNodeParameter('inputs', i, {}));
					if (!parsed.ok) {
						throw invalidParameter(
							node,
							'Inputs (JSON)',
							parsed.reason === 'unparsable' ? 'is not valid JSON' : 'is not a JSON object',
							'Give it a JSON object keyed by input name, for example { "source": "https://example.com/video.mp4" }.',
							i,
						);
					}

					const created = await rendobarApiRequest.call(
						this,
						{
							method: 'POST',
							path: '/jobs',
							body: {
								type: jobType,
								inputs: parsed.value,
								params: readObject(this.getNodeParameter('params', i, {}), 'value') ?? {},
								// The key has to be stable across n8n's retry of this step (so a
								// transient stall doesn't charge twice) AND unique per
								// submission. The API treats a repeated key as a hit and silently
								// returns the FIRST job with that key, so a key that collides hands
								// back another node's result instead of refusing. Node ID separates
								// two Rendobar nodes in one workflow; run index separates the
								// passes of a Loop Over Items; item index separates the items of
								// one pass. All three are stable across a retry.
								idempotencyKey: `n8n:${executionId}:${node.id}:${runIndex}:${i}`,
							},
							// Safe to repeat: the idempotency key above means a second attempt
							// settles on the job the first one created rather than a new one.
							idempotent: true,
						},
						i,
					);

					job = unwrapData(created) ?? {};

					if (this.getNodeParameter('waitForCompletion', i, false) === true) {
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
							const pollMs = toWholeNumber(this.getNodeParameter('pollInterval', i, 5), 5, 1) * 1000;
							const maxWaitMs =
								toWholeNumber(this.getNodeParameter('maxWait', i, 300), 300, 1) * 1000;
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
						this.getNodeParameter('jobId', i, '', { extractValue: true }),
						'Job',
						i,
					);
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

				// Optional: pull the headline output file onto the item so the next
				// node can pass the produced file along. Only on Get, opt-in, and only
				// when the finished job actually produced a file.
				if (operation === 'get' && this.getNodeParameter('downloadOutput', i, false) === true) {
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
