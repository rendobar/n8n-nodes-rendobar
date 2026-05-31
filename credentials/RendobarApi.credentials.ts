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

	icon: Icon = 'file:../icons/rendobar.svg';

	documentationUrl = 'https://rendobar.com/docs';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Your Rendobar API key (starts with rb_). Create one in the dashboard.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.rendobar.com',
			description: 'Override only to target a non-production environment.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
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
