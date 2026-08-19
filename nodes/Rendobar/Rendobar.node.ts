import {
	NodeConnectionTypes,
	NodeApiError,
	NodeOperationError,
	sleep,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
	type IDataObject,
	type JsonObject,
} from 'n8n-workflow';
import { rendobarApiRequest, rendobarUpload } from './shared/transport';
import { getJobTypes } from './listSearch/getJobTypes';
import { getJobFields } from './methods/getJobFields';
import { buildJobItem, JOB_FIELDS, titleCaseFieldName, type OutputMode } from './shared/output';

const TERMINAL_STATUSES = new Set(['complete', 'failed', 'cancelled']);

// GET /jobs caps a page at 100. Return All walks pages of this size.
const MAX_PAGE_SIZE = 100;

// A produced file in the unified job output. `url` is a ready-to-fetch,
// time-limited URL; `type` is an open enum (video|image|audio|captions|
// playlist|data|other) derived from the extension — tolerate unknown values.
interface OutputFile {
	url: string;
	path: string;
	type: string;
	size: number;
	meta?: IDataObject;
}

// Acronyms the generic humanizer would title-case into something n8n's style
// guide rejects ("Id", "Url").
const FIELD_LABEL_OVERRIDES: Record<string, string> = {
	id: 'ID',
	orgId: 'Org ID',
	webUrl: 'Web URL',
	eta: 'ETA',
	timeoutMs: 'Timeout Ms',
};

// Derived from the single source of truth in shared/output.ts, which is already
// sorted, so the dropdown reads alphabetically without a second hand-kept list.
const JOB_FIELD_OPTIONS: INodePropertyOptions[] = JOB_FIELDS.map((field) => ({
	name: FIELD_LABEL_OVERRIDES[field] ?? titleCaseFieldName(field),
	value: field,
}));

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
): Promise<IDataObject> {
	const deadline = Date.now() + maxWaitMs;
	for (;;) {
		const response = (await rendobarApiRequest.call(
			this,
			'GET',
			`/jobs/${encodeURIComponent(jobId)}`,
		)) as IDataObject;
		const job = (response.data as IDataObject) ?? response;

		if (TERMINAL_STATUSES.has(job.status as string)) {
			if (job.status === 'failed') {
				throw new NodeApiError(this.getNode(), job as JsonObject, {
					itemIndex,
					message: `Rendobar could not complete job ${jobId}`,
					description:
						'Open the job in the Rendobar dashboard to see the underlying error, correct the inputs or parameters, then run the workflow again.',
				});
			}
			return response;
		}

		if (Date.now() >= deadline) {
			throw new NodeOperationError(
				this.getNode(),
				`Job ${jobId} is still running after ${Math.round(maxWaitMs / 1000)}s`,
				{
					itemIndex,
					description:
						'Fetch it later with Get Job, or start the workflow from the Rendobar Trigger node, which is event-driven and does not block. Raising Max Wait also works for jobs that just need longer.',
				},
			);
		}

		await sleep(pollMs);
	}
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
						description: 'Cancel a job that is still running',
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
						description: 'Fetch a job by ID, including its status and output',
					},
					{
						name: 'Get Many',
						value: 'getAll',
						action: 'Get many jobs',
						description: 'List many jobs, newest first, with optional filters',
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
						description:
							'Upload a binary file from a previous node and get a URL to use as a job input',
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
				description: 'Input files for the job, e.g. { "source": "https://example.com/video.mp4" }',
			},
			{
				displayName: 'Parameters',
				name: 'params',
				type: 'resourceMapper',
				noDataExpression: true,
				default: { mappingMode: 'defineBelow', value: null },
				displayOptions: { show: { resource: ['job'], operation: ['create'] } },
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
					'Whether to wait until the job finishes and return its result. Good for short jobs. For long jobs prefer the Rendobar Trigger node, which is event-driven and does not block the workflow.',
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
				description: 'Stop waiting and raise an error after this many seconds',
			},
			{
				displayName: 'Job ID',
				name: 'jobId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['job'], operation: ['get', 'cancel'] } },
				placeholder: 'e.g. job_abc123',
				description: 'The ID of the job',
			},
			{
				displayName: 'Download Output File',
				name: 'downloadOutput',
				type: 'boolean',
				default: false,
				displayOptions: { show: { resource: ['job'], operation: ['get'] } },
				description:
					"Whether to download the headline output file (the result's file URL) into a binary property so the next node can use it directly. Only applies to completed jobs that produced a file.",
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
				description: 'Name of the binary property to store the downloaded output file under',
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
				displayName: 'Input Binary Field',
				name: 'binaryProperty',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: { show: { resource: ['file'], operation: ['upload'] } },
				placeholder: 'e.g. data',
				hint: 'The name of the input field holding the binary file to upload',
				description:
					'Name of the binary property from a previous node that contains the file to upload',
			},
			{
				displayName: 'Filename',
				name: 'uploadFilename',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['file'], operation: ['upload'] } },
				placeholder: 'e.g. clip.mp4',
				description:
					"Override the filename sent to Rendobar. Defaults to the binary data's own file name.",
			},
			{
				displayName: 'Output',
				name: 'output',
				type: 'options',
				default: 'simplified',
				displayOptions: { show: { resource: ['job'] } },
				description:
					'How much of the job to put on the item. A raw job carries around 32 fields, which is more than most workflows need and more than an AI agent can usefully read.',
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
							'Return the ten fields workflows use: ID, type, status, cost, output, timings',
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
		],
	};

	methods = {
		listSearch: { getJobTypes },
		resourceMapping: { getJobFields },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		// Branch on `operation` rather than `resource`: operation values are unique
		// across resources, so workflows saved before the Resource selector existed
		// keep executing unchanged.
		const operation = this.getNodeParameter('operation', 0) as string;
		const executionId = this.getExecutionId();
		const nodeId = this.getNode().id;
		// Present on a normal execution; absent in some tool/partial-execution
		// contexts, where there is only ever one pass anyway.
		const runIndex = this.getExecuteData()?.runIndex ?? 0;
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const outputMode =
					operation === 'upload'
						? 'raw'
						: (this.getNodeParameter('output', i, 'simplified') as OutputMode);
				const outputFields =
					outputMode === 'selected'
						? (this.getNodeParameter('outputFields', i, []) as string[])
						: [];

				if (operation === 'getAll') {
					const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
					const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
					const limit = returnAll ? Infinity : (this.getNodeParameter('limit', i, 50) as number);

					let offset = 0;
					for (;;) {
						const pageSize = Math.min(
							MAX_PAGE_SIZE,
							limit === Infinity ? MAX_PAGE_SIZE : limit - offset,
						);
						const page = (await rendobarApiRequest.call(this, 'GET', '/jobs', undefined, {
							...filters,
							limit: pageSize,
							offset,
						})) as IDataObject;
						const jobs = (page.data as IDataObject[]) ?? [];

						for (const job of jobs) {
							returnData.push(buildJobItem(job, i, outputMode, outputFields));
						}

						offset += jobs.length;
						const total = (page.meta as IDataObject | undefined)?.total as number | undefined;
						const exhausted =
							jobs.length < pageSize || (typeof total === 'number' && offset >= total);
						if (exhausted || offset >= limit) break;
					}

					continue;
				}

				let responseData: IDataObject;

				if (operation === 'create') {
					const jobType = this.getNodeParameter('jobType', i, '', {
						extractValue: true,
					}) as string;
					const inputsRaw = this.getNodeParameter('inputs', i, {}) as IDataObject | string;
					const inputs = typeof inputsRaw === 'string' ? JSON.parse(inputsRaw || '{}') : inputsRaw;
					const mapper = this.getNodeParameter('params', i, {}) as { value?: IDataObject | null };

					responseData = (await rendobarApiRequest.call(this, 'POST', '/jobs', {
						type: jobType,
						inputs,
						params: mapper.value ?? {},
						// The key has to be stable across n8n's retry of this step (so a
						// transient failure doesn't charge twice) AND unique per
						// submission. The API treats a repeated key as a hit and silently
						// returns the FIRST job with that key, so a key that collides hands
						// back another node's result instead of erroring. Node ID separates
						// two Rendobar nodes in one workflow; run index separates the
						// passes of a Loop Over Items; item index separates the items of
						// one pass. All three are stable across a retry.
						idempotencyKey: `n8n:${executionId}:${nodeId}:${runIndex}:${i}`,
					})) as IDataObject;

					if (this.getNodeParameter('waitForCompletion', i, false) as boolean) {
						const created = (responseData.data as IDataObject) ?? responseData;
						const jobId = created.id as string;
						if (!TERMINAL_STATUSES.has(created.status as string)) {
							const pollMs = (this.getNodeParameter('pollInterval', i, 5) as number) * 1000;
							const maxWaitMs = (this.getNodeParameter('maxWait', i, 300) as number) * 1000;
							responseData = await waitForJob.call(this, jobId, pollMs, maxWaitMs, i);
						}
					}
				} else if (operation === 'upload') {
					const binaryProperty = this.getNodeParameter('binaryProperty', i) as string;
					const binary = this.helpers.assertBinaryData(i, binaryProperty);
					const buffer = await this.helpers.getBinaryDataBuffer(i, binaryProperty);
					const filename =
						(this.getNodeParameter('uploadFilename', i, '') as string) ||
						binary.fileName ||
						'upload';
					const contentType = binary.mimeType || 'application/octet-stream';

					responseData = await rendobarUpload.call(this, buffer, filename, contentType);
				} else {
					const jobId = this.getNodeParameter('jobId', i) as string;
					const path = `/jobs/${encodeURIComponent(jobId)}`;
					responseData =
						operation === 'cancel'
							? ((await rendobarApiRequest.call(this, 'POST', `${path}/cancel`)) as IDataObject)
							: ((await rendobarApiRequest.call(this, 'GET', path)) as IDataObject);
				}

				const job = (responseData.data as IDataObject) ?? responseData;
				const item = buildJobItem(job, i, outputMode, outputFields);

				// Optional: pull the headline output file into a binary property so the
				// next node can pass the produced file along. Only on Get Job, opt-in,
				// and only when the completed job actually produced a file.
				if (operation === 'get' && (this.getNodeParameter('downloadOutput', i, false) as boolean)) {
					// `file` comes straight from the API's unified output contract, so
					// it's an OutputFile or null by construction. Read it off the job
					// rather than the item, which may have been narrowed by Output.
					const file = ((job.output as IDataObject | undefined)?.file as OutputFile | null) ?? null;
					if (file?.url) {
						const binaryProperty = this.getNodeParameter(
							'outputBinaryProperty',
							i,
							'data',
						) as string;
						// `encoding: 'arraybuffer'` makes httpRequest resolve to an
						// ArrayBuffer, but its return type is the union for all encodings,
						// so narrow it here before wrapping in a Buffer.
						const fileBuffer = (await this.helpers.httpRequest({
							method: 'GET',
							url: file.url,
							encoding: 'arraybuffer',
							returnFullResponse: false,
						})) as ArrayBuffer;
						item.binary = {
							[binaryProperty]: await this.helpers.prepareBinaryData(
								Buffer.from(fileBuffer),
								file.path,
							),
						};
					}
				}

				returnData.push(item);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: error instanceof Error ? error.message : String(error) },
						pairedItem: { item: i },
					});
					continue;
				}
				// waitForJob already throws well-formed n8n errors; re-wrapping them
				// would double-wrap and turn a wait timeout into an API error. Every
				// branch still throws a NodeApiError or a NodeOperationError.
				throw error instanceof NodeApiError || error instanceof NodeOperationError
					? error
					: new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
