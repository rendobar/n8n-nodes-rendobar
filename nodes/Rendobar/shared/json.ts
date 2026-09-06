import type { JsonObject, JsonValue } from 'n8n-workflow';

// Narrowing primitives for JSON from the Rendobar API.
//
// n8n's HTTP helpers type a response body as `any`. `shared/transport.ts` turns
// that into `JsonValue` once, and everything downstream uses the guards below:
// total functions returning `undefined` rather than throwing.
//
// The types are n8n's own, and `JsonObject` is structurally assignable to
// `IDataObject`, so a parsed body reaches `INodeExecutionData.json` with no
// assertion. No schema library: a verified community node ships no runtime deps.

export type { JsonObject, JsonValue };

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asObject(value: JsonValue | undefined): JsonObject | undefined {
	return isJsonObject(value) ? value : undefined;
}

export function objectAt(source: JsonValue | undefined, key: string): JsonObject | undefined {
	return isJsonObject(source) ? asObject(source[key]) : undefined;
}

export function stringAt(source: JsonValue | undefined, key: string): string | undefined {
	if (!isJsonObject(source)) return undefined;
	const value = source[key];
	return typeof value === 'string' ? value : undefined;
}

export function numberAt(source: JsonValue | undefined, key: string): number | undefined {
	if (!isJsonObject(source)) return undefined;
	const value = source[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function booleanAt(source: JsonValue | undefined, key: string): boolean | undefined {
	if (!isJsonObject(source)) return undefined;
	const value = source[key];
	return typeof value === 'boolean' ? value : undefined;
}

export function arrayAt(source: JsonValue | undefined, key: string): JsonValue[] | undefined {
	if (!isJsonObject(source)) return undefined;
	const value = source[key];
	return Array.isArray(value) ? value : undefined;
}

export function objectsAt(source: JsonValue | undefined, key: string): JsonObject[] {
	return (arrayAt(source, key) ?? []).filter(isJsonObject);
}

export function stringsAt(source: JsonValue | undefined, key: string): string[] {
	return (arrayAt(source, key) ?? []).filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Most Rendobar responses are `{ data: <payload> }`. A few (`POST /assets`) put
 * `data` beside a sibling, so callers still get something when it is absent.
 */
export function unwrapData(response: JsonValue | undefined): JsonObject | undefined {
	return objectAt(response, 'data') ?? asObject(response);
}

// n8n parameter bags. `getNodeParameter` returns a broad union (collection,
// resource-mapper value, resource locator). These read one key off it without
// assuming which member it is.

export function readValue(source: unknown, key: string): unknown {
	return valueAt(source, key);
}

function valueAt(source: unknown, key: string): unknown {
	if (typeof source !== 'object' || source === null) return undefined;
	if (!(key in source)) return undefined;
	return Reflect.get(source, key);
}

export function readString(source: unknown, key: string): string | undefined {
	const value = valueAt(source, key);
	return typeof value === 'string' && value !== '' ? value : undefined;
}

export function readNumber(source: unknown, key: string): number | undefined {
	const value = valueAt(source, key);
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Narrows an unknown value to a JSON object. Its input is always a node
 * parameter, and n8n stores only JSON-serialisable values, so once the guard
 * says plain object its members are `JsonValue` by construction. The only place
 * here that trusts a parameter without checking it member by member.
 */
function asParameterObject(value: unknown): JsonObject | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	return value as JsonObject;
}

export function readObject(source: unknown, key: string): JsonObject | undefined {
	return asParameterObject(valueAt(source, key));
}

/**
 * A parameter the user typed as JSON text or produced from an expression.
 * Returns a union rather than throwing, so the caller names its own parameter.
 */
export type JsonParameter =
	| { ok: true; value: JsonObject }
	| { ok: false; reason: 'unparsable' | 'notAnObject' };

export function readJsonParameter(raw: unknown): JsonParameter {
	if (raw === undefined || raw === null) return { ok: true, value: {} };

	if (typeof raw === 'string') {
		const text = raw.trim();
		if (text === '') return { ok: true, value: {} };

		let parsed: JsonValue;
		try {
			// `JSON.parse` is typed `any`; its grammar only produces `JsonValue`.
			parsed = JSON.parse(text) as JsonValue;
		} catch {
			return { ok: false, reason: 'unparsable' };
		}

		const object = asObject(parsed);
		return object === undefined ? { ok: false, reason: 'notAnObject' } : { ok: true, value: object };
	}

	const object = asParameterObject(raw);
	return object === undefined ? { ok: false, reason: 'notAnObject' } : { ok: true, value: object };
}

/** Converts a date-time parameter (ISO 8601, as n8n emits) to Unix ms. */
export function readUnixMs(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value !== 'string' || value.trim() === '') return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}
