import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class RendobarApi implements ICredentialType {
	name = 'rendobarApi';

	displayName = 'Rendobar API';

	icon: Icon = { light: 'file:../icons/rendobar.svg', dark: 'file:../icons/rendobar.dark.svg' };

	documentationUrl = 'https://rendobar.com/docs';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'e.g. rb_live_abc123',
			description:
				'The API key to authenticate with. Keys start with rb_ and are created in the Rendobar dashboard.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.rendobar.com',
			placeholder: 'e.g. https://api.rendobar.com',
			description:
				'The API address to call. Change it only to reach a non-production Rendobar environment.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
				// Usage attribution: identify this integration as the n8n client.
				'X-Rendobar-Client': 'n8n',
			},
		},
	};

	// Validates the key and doubles as the connection label source.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/orgs/current',
			method: 'GET',
		},
	};
}
