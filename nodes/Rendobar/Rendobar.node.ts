import {
	NodeConnectionTypes,
	NodeApiError,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type IDataObject,
	type JsonObject,
} from 'n8n-workflow';
import { rendobarApiRequest } from './shared/transport';
import { getJobTypes } from './listSearch/getJobTypes';
import { getJobFields } from './methods/getJobFields';

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
				displayName: 'Job ID',
				name: 'jobId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['get', 'cancel'] } },
				placeholder: 'e.g. job_abc123',
				description: 'The ID of the job',
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
				} else {
					const jobId = this.getNodeParameter('jobId', i) as string;
					const path = `/jobs/${encodeURIComponent(jobId)}`;
					responseData =
						operation === 'cancel'
							? ((await rendobarApiRequest.call(this, 'POST', `${path}/cancel`)) as IDataObject)
							: ((await rendobarApiRequest.call(this, 'GET', path)) as IDataObject);
				}

				const data = (responseData?.data as IDataObject) ?? responseData;
				returnData.push({ json: data, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
