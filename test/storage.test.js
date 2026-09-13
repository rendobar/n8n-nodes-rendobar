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

test('a path with no connection stops before the job is submitted', () => {
	const read = readDestinations({ destination: [{ storageId: ' ', path: 'exports' }] });
	assert.equal(read.ok, false);
	assert.match(read.how, /connection/);
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
