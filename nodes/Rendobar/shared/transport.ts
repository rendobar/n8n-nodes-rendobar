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

// Streams a raw file buffer to POST /uploads (ephemeral R2). The endpoint takes
// the bytes as the request body and a ?filename query hint, NOT multipart/form,
// so this can't go through rendobarApiRequest (which sends JSON). Returns the
// parsed { data: { downloadUrl } } envelope.
export async function rendobarUpload(
	this: IExecuteFunctions,
	file: Buffer,
	filename: string,
	contentType: string,
) {
	const credentials = await this.getCredentials('rendobarApi');
	const baseUrl = (credentials.baseUrl as string) || 'https://api.rendobar.com';

	const options: IHttpRequestOptions = {
		method: 'POST',
		url: `${baseUrl}/uploads`,
		qs: { filename },
		body: file,
		headers: { 'Content-Type': contentType },
		// json:false keeps n8n from JSON-stringifying the binary body. The response
		// is still JSON, so we parse it ourselves below.
		json: false,
	};

	const response = await this.helpers.httpRequestWithAuthentication.call(
		this,
		'rendobarApi',
		options,
	);

	return typeof response === 'string' ? (JSON.parse(response) as IDataObject) : (response as IDataObject);
}
