import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

import { NODE_VERSION } from '../nodes/Rendobar/shared/version';

// An API key is the only credential this package offers, and that is a decision
// rather than an omission.
//
// Rendobar runs a live OAuth 2.1 authorization-code server. Its metadata at
// https://api.rendobar.com/.well-known/oauth-authorization-server advertises
// authorization_code + refresh_token, S256 PKCE, a `none` token-endpoint auth
// method (so a public client needs no secret), the scopes openid / profile /
// email / offline_access plus the resource scopes, and a dynamic client registration
// endpoint. n8n ships a generic OAuth2 credential a community node can extend.
//
// The two still do not meet, and the reason is registration, not the protocol:
//
//   1. n8n has no dynamic client registration. Its OAuth2 credential asks the
//      user for a Client ID and Secret, so the registration endpoint Rendobar
//      exposes is unreachable from n8n. Either Rendobar registers one client
//      dedicated to n8n and this package embeds its ID, or every user registers
//      their own by hand against an endpoint that has no UI.
//   2. n8n's redirect URI is `<instance>/rest/oauth2-credential/callback`, which
//      differs per self-hosted instance and cannot be enumerated ahead of time.
//      A shared n8n client would therefore have to accept redirect URIs that are
//      not known in advance. That is a security decision about the OAuth server,
//      and it is the actual blocker.
//   3. Scope and revocation need deciding: a workflow needs the job and asset
//      scopes and nothing else, and what a nine-hour job should do when its
//      refresh token is revoked mid-run has no answer yet.
//
// All three are product calls about the OAuth server rather than node work, and
// none of them buys a workflow anything an API key does not already give it. The
// key is scoped to one organization, revocable from the dashboard, and verified
// here by a real request. Until a Rendobar-side n8n client exists, this is the
// honest surface.
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
				// Usage attribution. `name/version` is the product form Rendobar
				// parses; a bare name still works but loses the half that says
				// which build a report came from.
				'X-Rendobar-Client': `n8n/${NODE_VERSION}`,
			},
		},
	};

	// Validates the key and doubles as the connection label source.
	test: ICredentialTestRequest = {
		request: {
			// Trailing slashes are trimmed the same way the node trims them, so a
			// base URL that works when the node runs also works when the user
			// presses Test.
			baseURL: '={{ $credentials.baseUrl.replace(/[/]+$/, "") }}',
			url: '/orgs/current',
			method: 'GET',
		},
	};
}
