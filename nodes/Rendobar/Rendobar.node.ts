import {
	NodeConnectionTypes,
	NodeApiError,
	NodeOperationError,
	sleep,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type IDataObject,
	type JsonObject,
} from 'n8n-workflow';
import { rendobarApiRequest, rendobarUpload } from './shared/transport';
import { getJobTypes } from './listSearch/getJobTypes';
import { getJobFields } from './methods/getJobFields';

const TERMINAL_STATUSES = new Set(['complete', 'failed', 'cancelled']);

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

// Every Rendobar job, for every job type, returns ONE output shape when it
// completes:
//   data      — job-type-specific computed result (probe/detections/transcript),
//               or null for file-only jobs.
//   file      — the headline result: a single output file OR a stream manifest
//               (.m3u8/.mpd). Always one of `files`. Null for data-only jobs/sets.
//   files     — every produced file, the complete list. [] for data-only jobs.
//   expiresAt — Unix ms when the file URLs expire, or null when there are none.
// We keep the full job under `json` and also lift these four fields to the top
// of the item so downstream nodes get clean, predictable fields without having
// to dig into `output` (and without narrowing on a per-job-type shape).
function buildJobItem(job: IDataObject, itemIndex: number): INodeExecutionData {
	const json: IDataObject = { ...job };
	const output = job.output as IDataObject | undefined;
	if (output) {
		json.data = output.data ?? null;
		json.file = (output.file as IDataObject | null) ?? null;
		json.files = (output.files as IDataObject[]) ?? [];
		json.expiresAt = output.expiresAt ?? null;
	}
	return { json, pairedItem: { item: itemIndex } };
}

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
					message: `Job ${jobId} failed`,
				});
			}
			return response;
		}

		if (Date.now() >= deadline) {
			throw new NodeOperationError(
				this.getNode(),
				`Job ${jobId} did not finish within ${Math.round(maxWaitMs / 1000)}s. It is still running — fetch it later with Get Job, or use the Rendobar Trigger node.`,
				{ itemIndex },
			);
		}

		await sleep(pollMs);
	}
}

export class Rendobar implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Rendobar',
		name: 'rendobar',
		icon: 'file:../../icons/rendobar.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Submit, fetch, and cancel Rendobar media processing jobs',
		defaults: { name: 'Rendobar' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'rendobarApi', required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Cancel Job',
						value: 'cancel',
						action: 'Cancel a job',
						description: 'Cancel a job that is still running',
					},
					{
						name: 'Create Job',
						value: 'create',
						action: 'Create a job',
						description: 'Submit a new media processing job',
					},
					{
						name: 'Get Job',
						value: 'get',
						action: 'Get a job',
						description: 'Fetch a job by ID, including its status and output',
					},
					{
						name: 'Upload File',
						value: 'upload',
						action: 'Upload a file',
						description:
							'Upload a binary file from a previous node and get a URL to use as a job input',
					},
				],
				default: 'create',
			},
			{
				displayName: 'Job Type',
				name: 'jobType',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				displayOptions: { show: { operation: ['create'] } },
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
						placeholder: 'e.g. raw.ffmpeg',
					},
				],
			},
			{
				displayName: 'Inputs (JSON)',
				name: 'inputs',
				type: 'json',
				default: '{}',
				displayOptions: { show: { operation: ['create'] } },
				description: 'Input files for the job, e.g. { "source": "https://example.com/video.mp4" }',
			},
			{
				displayName: 'Parameters',
				name: 'params',
				type: 'resourceMapper',
				noDataExpression: true,
				default: { mappingMode: 'defineBelow', value: null },
				displayOptions: { show: { operation: ['create'] } },
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
				displayOptions: { show: { operation: ['create'] } },
				description:
					'Whether to wait until the job finishes and return its result. Good for short jobs. For long jobs prefer the Rendobar Trigger node, which is event-driven and does not block the workflow.',
			},
			{
				displayName: 'Poll Interval (Seconds)',
				name: 'pollInterval',
				type: 'number',
				default: 5,
				typeOptions: { minValue: 2 },
				displayOptions: { show: { operation: ['create'], waitForCompletion: [true] } },
				description: 'How often to check the job status while waiting',
			},
			{
				displayName: 'Max Wait (Seconds)',
				name: 'maxWait',
				type: 'number',
				default: 300,
				typeOptions: { minValue: 5 },
				displayOptions: { show: { operation: ['create'], waitForCompletion: [true] } },
				description: 'Stop waiting and raise an error after this many seconds',
			},
			{
				displayName: 'Job ID',
				name: 'jobId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['get', 'cancel'] } },
				placeholder: 'e.g. job_abc123',
				description: 'The ID of the job',
			},
			{
				displayName: 'Download Output File',
				name: 'downloadOutput',
				type: 'boolean',
				default: false,
				displayOptions: { show: { operation: ['get'] } },
				description:
					"Whether to download the headline output file (the result's file URL) into a binary property so the next node can use it directly. Only applies to completed jobs that produced a file.",
			},
			{
				displayName: 'Output Binary Field',
				name: 'outputBinaryProperty',
				type: 'string',
				default: 'data',
				displayOptions: { show: { operation: ['get'], downloadOutput: [true] } },
				placeholder: 'data',
				description: 'Name of the binary property to store the downloaded output file under',
			},
			{
				displayName: 'Input Binary Field',
				name: 'binaryProperty',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: { show: { operation: ['upload'] } },
				placeholder: 'data',
				hint: 'The name of the input field holding the binary file to upload',
				description:
					'Name of the binary property from a previous node that contains the file to upload',
			},
			{
				displayName: 'Filename',
				name: 'uploadFilename',
				type: 'string',
				default: '',
				displayOptions: { show: { operation: ['upload'] } },
				placeholder: 'e.g. clip.mp4',
				description:
					"Override the filename sent to Rendobar. Defaults to the binary data's own file name.",
			},
		],
	};

	methods = {
		listSearch: { getJobTypes },
		resourceMapping: { getJobFields },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const operation = this.getNodeParameter('operation', 0) as string;
		const executionId = this.getExecutionId();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				let responseData: IDataObject;

				if (operation === 'create') {
					const jobType = this.getNodeParameter('jobType', i, '', {
						extractValue: true,
					}) as string;
					const inputsRaw = this.getNodeParameter('inputs', i, {}) as IDataObject | string;
					const inputs =
						typeof inputsRaw === 'string' ? JSON.parse(inputsRaw || '{}') : inputsRaw;
					const mapper = this.getNodeParameter('params', i, {}) as { value?: IDataObject | null };

					responseData = (await rendobarApiRequest.call(this, 'POST', '/jobs', {
						type: jobType,
						inputs,
						params: mapper.value ?? {},
						// Stable per execution+item so n8n's retry on a transient failure
						// reuses the same job instead of charging twice.
						idempotencyKey: `n8n:${executionId}:${i}`,
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
				const item = buildJobItem(job, i);

				// Optional: pull the headline output file into a binary property so the
				// next node can pass the produced file along. Only on Get Job, opt-in,
				// and only when the completed job actually produced a file.
				if (
					operation === 'get' &&
					(this.getNodeParameter('downloadOutput', i, false) as boolean)
				) {
					// buildJobItem populated json.file straight from the API's unified
					// output contract, so it's an OutputFile or null by construction.
					const file = (item.json.file as OutputFile | null) ?? null;
					if (file?.url) {
						const binaryProperty = this.getNodeParameter(
							'outputBinaryProperty',
							i,
							'data',
						) as string;
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
				// would double-wrap and turn a wait timeout into an API error.
				// eslint-disable-next-line @n8n/community-nodes/require-node-api-error -- error is already a NodeApiError/NodeOperationError here
				if (error instanceof NodeApiError || error instanceof NodeOperationError) throw error;
				throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
