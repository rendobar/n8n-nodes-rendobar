import {
	booleanAt,
	numberAt,
	objectsAt,
	readString,
	readValue,
	stringAt,
	stringsAt,
	unwrapData,
	type JsonObject,
	type JsonValue,
} from './json';

const PREFIX = 'storage://';

export type DestinationRead = { ok: true; uris: string[] } | { ok: false; what: string; how: string };

/**
 * The Destinations rows as storage:// URIs, in the order given.
 *
 * A row left completely empty is ignored, because n8n adds an empty row the
 * moment someone clicks Add Destination. A row with a path but no connection
 * is stopped: sending it would deliver somewhere nobody chose. Leading slashes
 * go and the rest is sent as written, so the API's template rules decide what a
 * folder or a token means.
 */
export function readDestinations(raw: unknown): DestinationRead {
	// `unknown`, not JsonValue: it arrives from readCreateOption, which returns
	// whatever the saved workflow holds. Read defensively rather than cast.
	const rows = readValue(raw, 'destination');
	const uris: string[] = [];
	for (const row of Array.isArray(rows) ? rows : []) {
		const id = (readString(row, 'storageId') ?? '').trim();
		const path = (readString(row, 'path') ?? '').trim().replace(/^\/+/, '');
		if (id === '' && path === '') continue;
		if (id === '') {
			return {
				ok: false,
				what: 'A destination has a path but no connection',
				how: 'Pick the connection to deliver to, or remove that destination.',
			};
		}
		const uri = path === '' ? `${PREFIX}${id}` : `${PREFIX}${id}/${path}`;
		if (!uris.includes(uri)) uris.push(uri);
	}
	return { ok: true, uris };
}

/** How every picker in the node shows a connection. */
export function connectionLabel(connection: JsonObject): string {
	return `${stringAt(connection, 'id') ?? ''} (${stringAt(connection, 'provider') ?? 'storage'}, ${stringAt(connection, 'bucket') ?? ''})`;
}

/** One connection as an item. The endpoint stays out: a workflow acts on the id. */
export function storageConnectionItem(connection: JsonObject): JsonObject {
	return {
		id: stringAt(connection, 'id') ?? null,
		provider: stringAt(connection, 'provider') ?? null,
		bucket: stringAt(connection, 'bucket') ?? null,
		region: stringAt(connection, 'region') ?? null,
		access: stringAt(connection, 'access') === 'read' ? 'read' : 'deliver',
		defaultDestination: booleanAt(connection, 'defaultDestination') === true,
		pending: booleanAt(connection, 'pending') === true,
	};
}

/** One page of `GET /storage/{id}/objects` as items, folders first. */
export function storageEntryItems(storageId: string, response: JsonValue | undefined): JsonObject[] {
	const page = unwrapData(response);
	const uri = (key: string) => `${PREFIX}${storageId}/${key}`;
	const folders: JsonObject[] = stringsAt(page, 'folders').map((path) => ({ type: 'folder', path, uri: uri(path) }));
	const files: JsonObject[] = objectsAt(page, 'objects').flatMap((object) => {
		const key = stringAt(object, 'key');
		if (key === undefined) return [];
		const modified = numberAt(object, 'lastModified');
		return [
			{
				type: 'file',
				path: key,
				size: numberAt(object, 'size') ?? null,
				lastModified: modified === undefined ? null : new Date(modified).toISOString(),
				uri: uri(key),
			},
		];
	});
	return [...folders, ...files];
}

/** The cursor for the next page, or undefined on the last one. */
export function nextStorageCursor(response: JsonValue | undefined): string | undefined {
	return stringAt(unwrapData(response), 'cursor');
}
