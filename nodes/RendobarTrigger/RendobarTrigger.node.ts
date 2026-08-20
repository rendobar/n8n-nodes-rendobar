import {
	NodeConnectionTypes,
	NodeOperationError,
	type IHookFunctions,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';
import { rendobarApiRequest, rendobarRequest } from '../Rendobar/shared/transport';
import { booleanAt, stringAt, stringsAt, unwrapData } from '../Rendobar/shared/json';

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

// A path segment that still carries a percent-escape after n8n has written it.
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/;

// n8n writes and matches a production webhook path with different encodings,
// and the address it hands a node is the one that does not work.
//
// Writing: NodeHelpers.getNodeWebhookPath joins the workflow ID, the node name
// put through encodeURIComponent, and the webhook's own path, and that string
// is stored verbatim in webhook_entity.webhookPath.
// Matching: the production route is `/webhook/*path`, so Express hands the
// handler segments it has already percent-decoded, which are joined and looked
// up against webhookPath with an exact string comparison.
//
// So a node name that needed escaping never matches its own registration: this
// node's default name, `Rendobar Trigger`, is stored as `rendobar%20trigger`
// and arrives as `rendobar trigger`, and every delivery 404s. n8n's own nodes
// break the same way — the effect is normally hidden because a node carrying a
// `webhookId` gets a UUID path with no name in it, and n8n assigns one whenever
// a workflow is saved through its API. A workflow that reached the database by
// another route (`n8n import:workflow`, a restore, an older export) has no
// `webhookId`, and then the name is the path.
//
// Encoding each segment once more is what closes it: Express's single decode
// then lands exactly on the string n8n stored. Segments that are already
// decode-stable — a workflow ID, a UUID, `webhook`, a name that needed no
// escaping — are left untouched, so this is a no-op for every address that
// works today.
export function deliverableWebhookUrl(webhookUrl: string): string {
	const url = new URL(webhookUrl);
	url.pathname = url.pathname
		.split('/')
		.map((segment) => (PERCENT_ESCAPE.test(segment) ? encodeURIComponent(segment) : segment))
		.join('/');
	return url.toString();
}

/** True when the registration already matches what this node wants delivered. */
export function registrationMatches(
	registered: { url?: string; events: string[]; active: boolean },
	wanted: { url: string; events: string[] },
): boolean {
	if (!registered.active) return false;
	if (registered.url !== wanted.url) return false;
	if (registered.events.length !== wanted.events.length) return false;
	const have = new Set(registered.events);
	return wanted.events.every((event) => have.has(event));
}

function selectedEvents(context: IHookFunctions): string[] {
	const events = context.getNodeParameter('events');
	return Array.isArray(events)
		? events.filter((event): event is string => typeof event === 'string')
		: [];
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
		// n8n's node details panel takes its headline from the trigger, so this
		// line stands for the whole package. "when a Rendobar event fires" told a
		// reader nothing about what the events are, and left five actions reading
		// as an afterthought behind a node that only listens.
		description:
			'Starts the workflow when a Rendobar media job completes, stops or is cancelled, or when the account balance runs low',
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
			// n8n skips `create` when this reports true, so trusting the stored id
			// alone leaves the trigger silently dead whenever the registration has
			// gone away on Rendobar's side — after a failed `delete`, or if someone
			// removed it in the dashboard. The registration is checked for real, and
			// a drifted URL or event list is corrected in place rather than by
			// registering a second endpoint.
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				const endpointId = typeof data.endpointId === 'string' ? data.endpointId : undefined;
				if (endpointId === undefined) return false;

				const path = `/webhooks/endpoints/${encodeURIComponent(endpointId)}`;
				const response = await rendobarRequest.call(this, {
					method: 'GET',
					path,
					idempotent: true,
				});

				// Gone from Rendobar: forget it so n8n registers a fresh one.
				if (response.statusCode === 404 || response.statusCode === 410) {
					delete data.endpointId;
					return false;
				}

				if (response.statusCode < 200 || response.statusCode >= 300) {
					throw new NodeOperationError(
						this.getNode(),
						'Rendobar would not confirm this workflow is still subscribed',
						{
							description:
								'Check the Rendobar credential and that this n8n instance can reach the API, then activate the workflow again.',
						},
					);
				}

				const endpoint = unwrapData(response.body);
				const nodeUrl = this.getNodeWebhookUrl('default');
				const wantedUrl = nodeUrl === undefined ? undefined : deliverableWebhookUrl(nodeUrl);
				const wantedEvents = selectedEvents(this);

				const registeredUrl = stringAt(endpoint, 'url');
				const registered = {
					...(registeredUrl === undefined ? {} : { url: registeredUrl }),
					events: stringsAt(endpoint, 'subscribedEvents'),
					// An endpoint Rendobar disabled after repeated non-delivery comes
					// back with active: false, which has to count as drift.
					active: booleanAt(endpoint, 'active') ?? true,
				};

				if (
					wantedUrl !== undefined &&
					!registrationMatches(registered, { url: wantedUrl, events: wantedEvents })
				) {
					await rendobarApiRequest.call(this, {
						method: 'PATCH',
						path,
						body: { url: wantedUrl, subscribedEvents: wantedEvents, active: true },
						// Writing the same desired state twice lands on the same result.
						idempotent: true,
					});
				}

				return true;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const nodeUrl = this.getNodeWebhookUrl('default');
				if (nodeUrl === undefined) {
					throw new NodeOperationError(this.getNode(), 'This node has no webhook address yet', {
						description:
							'Save the workflow, then activate it so n8n can hand Rendobar an address to deliver to.',
					});
				}
				const webhookUrl = deliverableWebhookUrl(nodeUrl);

				// The API's create-endpoint schema is { name, url, subscribedEvents }.
				// `name` is required (1-50 chars) and the event array is
				// `subscribedEvents`, not `events` — anything else is stripped by the
				// validator and the request 400s.
				const response = await rendobarApiRequest.call(this, {
					method: 'POST',
					path: '/webhooks/endpoints',
					body: {
						name: buildEndpointName(this.getWorkflow().name, this.getNode().name),
						url: webhookUrl,
						subscribedEvents: selectedEvents(this),
					},
				});

				const endpointId = stringAt(unwrapData(response), 'id');
				if (endpointId === undefined) {
					throw new NodeOperationError(
						this.getNode(),
						'Rendobar accepted the subscription but did not name it',
						{
							description:
								'Activate the workflow again. If it keeps happening, remove any stale n8n endpoints in the Rendobar dashboard first.',
						},
					);
				}

				const data = this.getWorkflowStaticData('node');
				data.endpointId = endpointId;
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
				const endpointId = typeof data.endpointId === 'string' ? data.endpointId : undefined;
				if (endpointId === undefined) return true;

				const response = await rendobarRequest.call(this, {
					method: 'DELETE',
					path: `/webhooks/endpoints/${encodeURIComponent(endpointId)}`,
					idempotent: true,
				});

				// Already gone counts as removed.
				const removed =
					(response.statusCode >= 200 && response.statusCode < 300) ||
					response.statusCode === 404 ||
					response.statusCode === 410;

				if (!removed) {
					this.logger.error(
						`Rendobar: the webhook endpoint ${endpointId} is still registered (status ${response.statusCode}).`,
					);
					// Keeping the ID in static data lets n8n retry the removal rather
					// than orphaning a live registration on Rendobar.
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
		// The delivered envelope is passed through whole: { version, event,
		// deliveryId, timestamp, orgId, data }, where `data` carries the job.
		return {
			workflowData: [this.helpers.returnJsonArray([this.getBodyData()])],
		};
	}
}
