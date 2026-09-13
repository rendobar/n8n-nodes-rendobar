// Shared by the tests that drive the node's HTTP calls without an n8n runtime.
const NODE = { id: 'node_a', name: 'Rendobar', type: 'rendobar', typeVersion: 1, position: [0, 0] };

/**
 * An IExecuteFunctions or ILoadOptionsFunctions stand-in carrying only what the
 * transport touches, plus the URLs the node actually asked for.
 */
function fakeContext(responses) {
	const paths = [];
	return {
		paths,
		getNode: () => NODE,
		getCredentials: async () => ({ baseUrl: 'https://api.example.com' }),
		helpers: {
			httpRequestWithAuthentication: async (_credentialType, options) => {
				paths.push(options.url);
				const next = responses.shift();
				if (next === undefined) throw new Error('the node made an unexpected extra request');
				return { statusCode: next.statusCode, headers: {}, body: next.body };
			},
		},
	};
}

module.exports = { NODE, fakeContext };
