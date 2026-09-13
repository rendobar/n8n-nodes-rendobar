// Shared by the tests that drive the node's HTTP calls without an n8n runtime.
const NODE = { id: 'node_a', name: 'Rendobar', type: 'rendobar', typeVersion: 1, position: [0, 0] };

/**
 * An IExecuteFunctions or ILoadOptionsFunctions stand-in carrying only what the
 * transport touches, plus the URLs the node actually asked for.
 *
 * `params` and `items` are only for a test that drives execute() itself rather
 * than a smaller exported helper: `params` answers getNodeParameter by name
 * (falling back to whatever the call site passed, same as n8n does for an
 * unset parameter), and `items` is what getInputData() returns. `requests`
 * carries the method, URL and qs of every request made, for a test that needs
 * more than the URL alone.
 */
function fakeContext(responses, { params = {}, items = [{ json: {} }] } = {}) {
	const paths = [];
	const requests = [];
	return {
		paths,
		requests,
		getNode: () => NODE,
		getCredentials: async () => ({ baseUrl: 'https://api.example.com' }),
		getInputData: () => items,
		getExecutionId: () => 'exec_1',
		continueOnFail: () => false,
		getNodeParameter: (name, _itemIndex, fallback) => (name in params ? params[name] : fallback),
		helpers: {
			httpRequestWithAuthentication: async (_credentialType, options) => {
				paths.push(options.url);
				requests.push({ method: options.method, url: options.url, qs: options.qs });
				const next = responses.shift();
				if (next === undefined) throw new Error('the node made an unexpected extra request');
				return { statusCode: next.statusCode, headers: {}, body: next.body };
			},
		},
	};
}

module.exports = { NODE, fakeContext };
