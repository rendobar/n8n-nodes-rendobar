// Pins how the Destinations rows become storage:// URIs and how storage
// responses become labels and items, without an n8n runtime.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
	readDestinations,
	connectionLabel,
	storageConnectionItem,
	storageEntryItems,
	nextStorageCursor,
} = require('../dist/nodes/Rendobar/shared/storage.js');

test('a connection with no path delivers by its own template', () => {
	assert.deepEqual(readDestinations({ destination: [{ storageId: 'prod-media', path: '' }] }), {
		ok: true,
		uris: ['storage://prod-media'],
	});
});

test('a folder or template is appended once, without a leading slash', () => {
	assert.deepEqual(readDestinations({ destination: [{ storageId: 'prod-media', path: '/exports/{date}' }] }), {
		ok: true,
		uris: ['storage://prod-media/exports/{date}'],
	});
});

test('nothing configured sends nothing, so the account default still applies', () => {
	assert.deepEqual(readDestinations({}), { ok: true, uris: [] });
	assert.deepEqual(readDestinations(undefined), { ok: true, uris: [] });
	assert.deepEqual(readDestinations({ destination: [{ storageId: '', path: '' }] }), { ok: true, uris: [] });
});

test('a path with no connection stops before the job is submitted, naming the row', () => {
	const read = readDestinations({ destination: [{ storageId: ' ', path: 'exports' }] });
	assert.equal(read.ok, false);
	assert.equal(read.what, 'row 1 has a path but no connection');
	assert.equal(read.how, 'Pick a connection for that row, or remove it.');
});

test('the row named in the stop is the position in the list, including rows already sent', () => {
	const read = readDestinations({
		destination: [
			{ storageId: 'prod-media', path: '' },
			{ storageId: '', path: '' },
			{ storageId: ' ', path: 'exports' },
		],
	});
	assert.equal(read.ok, false);
	assert.equal(read.what, 'row 3 has a path but no connection');
});

test('the same connection and path named twice is one destination', () => {
	const row = { storageId: 'prod-media', path: 'exports' };
	assert.deepEqual(readDestinations({ destination: [row, row] }).uris, ['storage://prod-media/exports']);
});

test('a connection reads as its id, provider and bucket', () => {
	assert.equal(connectionLabel({ id: 'raw', provider: 'r2', bucket: 'raw-footage' }), 'raw (r2, raw-footage)');
});

test('a connection item carries what a workflow acts on and nothing about how it connects', () => {
	const item = storageConnectionItem({
		id: 'raw',
		provider: 'r2',
		bucket: 'raw',
		region: 'auto',
		endpoint: 'https://acct.r2.cloudflarestorage.com',
		access: 'read',
	});
	assert.deepEqual(item, {
		id: 'raw',
		provider: 'r2',
		bucket: 'raw',
		region: 'auto',
		access: 'read',
		defaultDestination: false,
		pending: false,
	});
});

test('a listing becomes folder items then file items, each with its storage URI', () => {
	const response = {
		data: {
			folders: ['raw/2026/'],
			objects: [
				{ key: 'raw/clip.mp4', size: 18400000, lastModified: 1757000000000 },
				{ key: 'raw/notes.txt', size: 800, lastModified: null },
			],
			cursor: 'tok',
		},
	};
	assert.deepEqual(storageEntryItems('prod-media', response), [
		{ type: 'folder', path: 'raw/2026/', uri: 'storage://prod-media/raw/2026/' },
		{ type: 'file', path: 'raw/clip.mp4', size: 18400000, lastModified: new Date(1757000000000).toISOString(), uri: 'storage://prod-media/raw/clip.mp4' },
		{ type: 'file', path: 'raw/notes.txt', size: 800, lastModified: null, uri: 'storage://prod-media/raw/notes.txt' },
	]);
	assert.equal(nextStorageCursor(response), 'tok');
	assert.equal(nextStorageCursor({ data: { folders: [], objects: [], cursor: null } }), undefined);
});

const { fakeContext } = require('./helpers');
const { getStorageDestinations } = require('../dist/nodes/Rendobar/methods/getStorageDestinations.js');

test('the destination list offers only connections a job can write to, sorted', async () => {
	const options = await getStorageDestinations.call(
		fakeContext([
			{
				statusCode: 200,
				body: {
					data: [
						{ id: 'zeta', provider: 's3', bucket: 'z' },
						{ id: 'alpha', provider: 'r2', bucket: 'a' },
						{ id: 'read-only', provider: 's3', bucket: 'r', access: 'read' },
						{ id: 'setting-up', provider: 's3', bucket: 'w', pending: true },
					],
					meta: { total: 4 },
				},
			},
		]),
	);
	assert.deepEqual(options, [
		{ name: 'alpha (r2, a)', value: 'alpha' },
		{ name: 'zeta (s3, z)', value: 'zeta' },
	]);
});

test('a key without storage access is told to make a new one', async () => {
	await assert.rejects(
		getStorageDestinations.call(
			fakeContext([
				{
					statusCode: 403,
					body: { error: { code: 'INSUFFICIENT_SCOPE', message: 'This endpoint requires the storage:read scope.' } },
				},
			]),
		),
		(thrown) => /new key/i.test(`${thrown.description ?? ''} ${thrown.message ?? ''}`),
	);
});

const { searchStorageConnections } = require('../dist/nodes/Rendobar/listSearch/searchStorageConnections.js');
const { Rendobar } = require('../dist/nodes/Rendobar/Rendobar.node.js');

test('the connection picker lists every connection, read-only ones included, and filters by the typed term', async () => {
	const body = {
		data: [
			{ id: 'prod-media', provider: 's3', bucket: 'acme' },
			{ id: 'raw', provider: 'r2', bucket: 'raw', access: 'read' },
		],
		meta: { total: 2 },
	};
	const all = await searchStorageConnections.call(fakeContext([{ statusCode: 200, body }]));
	assert.deepEqual(all.results.map((r) => r.value), ['prod-media', 'raw']);
	const filtered = await searchStorageConnections.call(fakeContext([{ statusCode: 200, body }]), 'r2');
	assert.deepEqual(filtered.results.map((r) => r.value), ['raw']);
});

test('the node offers Storage Connection and Storage File, each with Get Many', () => {
	const properties = new Rendobar().description.properties;
	const resource = properties.find((p) => p.name === 'resource');
	assert.deepEqual(resource.options.map((o) => o.value), ['account', 'file', 'job', 'storageConnection', 'storageFile']);
	const values = properties.filter((p) => p.name === 'operation').flatMap((p) => p.options.map((o) => o.value));
	assert.ok(values.includes('getStorageConnections'));
	assert.ok(values.includes('getStorageFiles'));
});

test('Storage File Get Many with a limit stops after one page once it is full, folder first', async () => {
	const body = {
		data: {
			folders: ['raw/2026/'],
			objects: [
				{ key: 'raw/a.mp4', size: 10, lastModified: null },
				{ key: 'raw/b.mp4', size: 20, lastModified: null },
				{ key: 'raw/c.mp4', size: 30, lastModified: null },
			],
			cursor: 'more',
		},
	};
	const context = fakeContext([{ statusCode: 200, body }], {
		params: {
			operation: 'getStorageFiles',
			storageId: 'prod-media',
			folder: 'raw/2026/',
			returnAll: false,
			limit: 2,
		},
	});

	const [items] = await new Rendobar().execute.call(context);

	// A non-null cursor came back, but Limit was already full: no second page
	// is fetched for rows the workflow could never receive.
	assert.equal(context.requests.length, 1);
	assert.equal(context.requests[0].method, 'GET');
	assert.equal(context.requests[0].url, 'https://api.example.com/storage/prod-media/objects');
	assert.deepEqual(context.requests[0].qs, { prefix: 'raw/2026/' });
	assert.deepEqual(
		items.map((item) => item.json),
		[
			{ type: 'folder', path: 'raw/2026/', uri: 'storage://prod-media/raw/2026/' },
			{ type: 'file', path: 'raw/a.mp4', size: 10, lastModified: null, uri: 'storage://prod-media/raw/a.mp4' },
		],
	);
});

test('Storage File Get Many with Return All walks every page on the cursor it is handed', async () => {
	const page1 = {
		data: {
			folders: ['raw/2026/'],
			objects: [{ key: 'raw/a.mp4', size: 10, lastModified: null }],
			cursor: 'c2',
		},
	};
	const page2 = {
		data: { folders: [], objects: [{ key: 'raw/b.mp4', size: 20, lastModified: null }], cursor: null },
	};
	const context = fakeContext(
		[
			{ statusCode: 200, body: page1 },
			{ statusCode: 200, body: page2 },
		],
		{
			params: {
				operation: 'getStorageFiles',
				storageId: 'prod-media',
				folder: 'raw/2026/',
				returnAll: true,
			},
		},
	);

	const [items] = await new Rendobar().execute.call(context);

	assert.equal(context.requests.length, 2);
	assert.deepEqual(context.requests[0].qs, { prefix: 'raw/2026/' });
	assert.deepEqual(context.requests[1].qs, { prefix: 'raw/2026/', cursor: 'c2' });
	assert.deepEqual(
		items.map((item) => item.json),
		[
			{ type: 'folder', path: 'raw/2026/', uri: 'storage://prod-media/raw/2026/' },
			{ type: 'file', path: 'raw/a.mp4', size: 10, lastModified: null, uri: 'storage://prod-media/raw/a.mp4' },
			{ type: 'file', path: 'raw/b.mp4', size: 20, lastModified: null, uri: 'storage://prod-media/raw/b.mp4' },
		],
	);
});

test('a Folder without a trailing slash, or with a leading one, is still sent the way the API accepts', async () => {
	const empty = { data: { folders: [], objects: [], cursor: null } };

	for (const folder of ['raw', '/raw']) {
		const context = fakeContext([{ statusCode: 200, body: empty }], {
			params: { operation: 'getStorageFiles', storageId: 'prod-media', folder },
		});

		await new Rendobar().execute.call(context);

		assert.deepEqual(context.requests[0].qs, { prefix: 'raw/' }, `folder ${JSON.stringify(folder)}`);
	}
});
