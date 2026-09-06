import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

import { NODE_VERSION } from '../nodes/Rendobar/shared/version';

// API key only. No OAuth credential, for three reasons:
//  1. n8n has no dynamic client registration; its OAuth2 credential asks for a
//     Client ID and Secret, so Rendobar's registration endpoint is unreachable
//     from n8n.
//  2. n8n's redirect URI is `<instance>/rest/oauth2-credential/callback`, which
//     differs per self-hosted instance, so a shared client would have to accept
//     redirect URIs not known ahead of time.
//  3. Scope and revocation are undecided, including what a nine-hour job does
//     when its refresh token is revoked mid-run.
// All three are OAuth-server calls, not node work. Rendobar's server itself is
// live at /.well-known/oauth-authorization-server if that changes.
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
				// `name/version` is the form Rendobar parses. A bare name works but
				// loses the build a report came from.
				'X-Rendobar-Client': `n8n/${NODE_VERSION}`,
			},
		},
	};

	// Validates the key and doubles as the connection label source.
	test: ICredentialTestRequest = {
		request: {
			// Trimmed the same way the node trims it, so Test and a run agree.
			baseURL: '={{ $credentials.baseUrl.replace(/[/]+$/, "") }}',
			url: '/orgs/current',
			method: 'GET',
		},
	};
}
