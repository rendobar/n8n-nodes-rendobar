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

// Uploads a file to Rendobar via the /assets flow (presigned direct-to-R2):
// init -> PUT bytes to the presigned URL(s) -> complete. The old POST /uploads
// endpoint was removed; an uploaded file is referenced by its content `url`.
// Returns the ready asset envelope { data: { id, url, ... } }.
export async function rendobarUpload(
	this: IExecuteFunctions,
	file: Buffer,
	filename: string,
	contentType: string,
) {
	// 1. Init: reserve the asset and get the presigned upload target(s). The init
	// response is a discriminated union at the top level (status + data + upload),
	// not a { data } envelope.
	const init = (await rendobarApiRequest.call(this, 'POST', '/assets', {
		filename,
		size: file.length,
		contentType,
		lifecycle: 'ephemeral',
	})) as IDataObject;

	const status = init.status as string;
	// An identical file already exists for this org — nothing to upload.
	if (status === 'deduplicated') return init;

	const asset = init.data as IDataObject;
	const assetId = asset.id as string;
	const upload = init.upload as IDataObject;

	// 2. PUT bytes straight to R2. Presigned URLs carry their own SigV4 auth, so
	// these requests must NOT include the Rendobar credential — use the plain
	// httpRequest helper, not the authenticated one.
	let completeBody: IDataObject = {};
	if (status === 'multipart') {
		const partSize = upload.partSize as number;
		const parts = upload.parts as Array<{ partNumber: number; url: string }>;
		const uploaded: Array<{ partNumber: number; etag: string }> = [];
		for (const part of parts) {
			const start = (part.partNumber - 1) * partSize;
			const chunk = file.subarray(start, Math.min(start + partSize, file.length));
			const res = (await this.helpers.httpRequest({
				method: 'PUT',
				url: part.url,
				body: chunk,
				headers: { 'Content-Type': contentType },
				json: false,
				returnFullResponse: true,
			})) as { headers: IDataObject };
			// R2 returns the part ETag, required to assemble the object at complete.
			const etag = (res.headers.etag ?? res.headers.ETag) as string;
			uploaded.push({ partNumber: part.partNumber, etag });
		}
		completeBody = { parts: uploaded };
	} else {
		// status === 'presigned' (single PUT). The server reads the ETag via
		// HeadObject at complete, so none is needed in the body.
		await this.helpers.httpRequest({
			method: 'PUT',
			url: upload.url as string,
			body: file,
			headers: { 'Content-Type': contentType },
			json: false,
		});
	}

	// 3. Finalize: the API verifies the object landed and marks the asset ready.
	return (await rendobarApiRequest.call(
		this,
		'POST',
		`/assets/${encodeURIComponent(assetId)}/complete`,
		completeBody,
	)) as IDataObject;
}
