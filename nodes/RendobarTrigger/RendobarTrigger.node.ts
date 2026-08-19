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

// POST /webhooks/endpoints validates `name` at 1-50 characters.
const MAX_ENDPOINT_NAME_LENGTH = 50;

// A human-recognisable label for the endpoint in the Rendobar dashboard, so an
// org with several n8n workflows can tell the registrations apart.
export function buildEndpointName(workflowName?: string, nodeName?: string): string {
	const parts = [workflowName, nodeName].filter(
		(part): part is string => typeof part === 'string' && part.trim().length > 0,
	);
	const label = parts.length > 0 ? `n8n: ${parts.join(' / ')}` : 'n8n';
	return label.slice(0, MAX_ENDPOINT_NAME_LENGTH);
}

// Starts a workflow when a Rendobar event fires (job completed/failed, etc.).
// On activate it registers this node's webhook URL with Rendobar
// (POST /webhooks/endpoints); on deactivate it removes it (DELETE). The
// endpoint id is kept in the node's static data so deactivate can clean up.
//
// Note: Rendobar must be able to reach the webhook URL. That works on a hosted
// or tunnelled n8n; a plain localhost n8n isn't reachable from the API.
// `usableAsTool` is deliberately absent. A trigger cannot be invoked as an AI
// tool, and n8n's own type only allows `true`, so there is no way to say 'no'
// other than omission. n8n's verification scanner agrees (its
// node-usable-as-tool rule exempts triggers and errors when one sets the flag);
// only the older plugin bundled with @n8n/node-cli asks for it, hence the
// disable below, which the scanner ignores by design.
// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool -- see above
export class RendobarTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Rendobar Trigger',
		name: 'rendobarTrigger',
		icon: { light: 'file:../../icons/rendobar.svg', dark: 'file:../../icons/rendobar.dark.svg' },
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

				// The API's create-endpoint schema is { name, url, subscribedEvents }.
				// `name` is required (1-50 chars) and the event array is
				// `subscribedEvents`, not `events` — anything else is stripped by the
				// validator and the request 400s.
				const response = (await rendobarApiRequest.call(this, 'POST', '/webhooks/endpoints', {
					name: buildEndpointName(this.getWorkflow().name, this.getNode().name),
					url: webhookUrl,
					subscribedEvents: events,
				})) as { data: { id: string } };

				const data = this.getWorkflowStaticData('node');
				data.endpointId = response.data.id;
				// The response also carries a plaintext `signingSecret`. It is
				// deliberately NOT persisted: n8n's workflow static data is stored
				// unencrypted and travels in workflow exports, and nothing here reads
				// it back. Inbound deliveries are trusted on the secrecy of the n8n
				// webhook URL, the same capability-URL model Rendobar's job callbacks
				// use. Verifying X-Rendobar-Signature (HMAC-SHA256 over
				// `${X-Rendobar-Timestamp}.${rawBody}`) needs the raw request body,
				// which this node does not currently request.
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
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					this.logger.error(
						`Rendobar: could not remove webhook endpoint ${data.endpointId as string}. ${reason}`,
					);
					// Reporting false keeps the endpoint ID in static data so n8n can retry
					// the removal, rather than orphaning a live registration on Rendobar.
					return false;
				}
				delete data.endpointId;
				// Clears the secret stored by node versions before 0.3.0.
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
