import type {
	IExecuteFunctions,
	IHookFunctions,
	ILoadOptionsFunctions,
	IHttpRequestMethods,
	IDataObject,
	IHttpRequestOptions,
} from 'n8n-workflow';

// Used by the design-time methods (listSearch, resourceMapping) and the trigger
// node, which call the API directly. The action operations use declarative
// routing instead, so they don't go through here.
export async function rendobarApiRequest(
	this: IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions,
	method: IHttpRequestMethods,
	resource: string,
	body?: IDataObject,
	qs: IDataObject = {},
) {
	const credentials = await this.getCredentials('rendobarApi');
	const baseUrl = (credentials.baseUrl as string) || 'https://api.rendobar.com';

	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}${resource}`,
		qs,
		json: true,
	};
	if (body !== undefined) options.body = body;

	return this.helpers.httpRequestWithAuthentication.call(this, 'rendobarApi', options);
}
