import {
	NodeConnectionTypes,
	type IHookFunctions,
	type IWebhookFunctions,
	type IDataObject,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookResponseData,
} from 'n8n-workflow';
import { rendobarApiRequest } from '../Rendobar/shared/transport';

// Starts a workflow when a Rendobar event fires (job completed/failed, etc.).
// On activate it registers this node's webhook URL with Rendobar
// (POST /webhooks/endpoints); on deactivate it removes it (DELETE). The
// endpoint id is kept in the node's static data so deactivate can clean up.
//
// Note: Rendobar must be able to reach the webhook URL. That works on a hosted
// or tunnelled n8n; a plain localhost n8n isn't reachable from the API.
// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool -- trigger nodes can't be agent tools; the type only allows `true`, so omit it
export class RendobarTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Rendobar Trigger',
		name: 'rendobarTrigger',
		icon: 'file:../../icons/rendobar.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow when a Rendobar event fires',
		defaults: { name: 'Rendobar Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'rendobarApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: ['job.completed', 'job.failed', 'job.cancelled'],
				description: 'The events that should start the workflow',
				options: [
					{ name: 'Balance Depleted', value: 'balance.depleted' },
					{ name: 'Balance Low', value: 'balance.low' },
					{ name: 'Job Cancelled', value: 'job.cancelled' },
					{ name: 'Job Completed', value: 'job.completed' },
					{ name: 'Job Created', value: 'job.created' },
					{ name: 'Job Failed', value: 'job.failed' },
					{ name: 'Job Started', value: 'job.started' },
				],
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				return Boolean(data.endpointId);
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default');
				const events = this.getNodeParameter('events') as string[];

				const response = (await rendobarApiRequest.call(this, 'POST', '/webhooks/endpoints', {
					url: webhookUrl,
					events,
				})) as { data: { id: string; signingSecret: string } };

				const data = this.getWorkflowStaticData('node');
				data.endpointId = response.data.id;
				// Stored for future signature verification; not used yet.
				data.signingSecret = response.data.signingSecret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				if (!data.endpointId) return true;
				try {
					await rendobarApiRequest.call(
						this,
						'DELETE',
						`/webhooks/endpoints/${data.endpointId as string}`,
					);
				} catch {
					return false;
				}
				delete data.endpointId;
				delete data.signingSecret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const body = this.getBodyData();
		return {
			workflowData: [this.helpers.returnJsonArray([body as IDataObject])],
		};
	}
}
