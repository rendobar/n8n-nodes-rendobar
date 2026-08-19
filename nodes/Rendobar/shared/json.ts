import type { JsonObject, JsonValue } from 'n8n-workflow';

// Narrowing primitives for values that arrive as JSON from the Rendobar API.
//
// n8n's HTTP helpers type a response body as `any`, so without this every
// consumer ends up asserting its way to a shape the compiler never checked. The
// rule this package follows is "parse at the boundary, trust internally":
// `shared/transport.ts` turns the helper's `any` into `JsonValue` exactly once,
// with a comment, and everything downstream uses the guards below, which are
// total functions returning `undefined` rather than throwing or lying.
//
// The types are n8n's own (`JsonValue` / `JsonObject`) rather than a parallel
// set, and `JsonObject` is structurally assignable to `IDataObject`, so a
// parsed body reaches `INodeExecutionData.json` with no assertion anywhere.
//
// There is no schema library here on purpose: a verified community node must
// ship no runtime dependencies, so the checks are hand-rolled and kept small.

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
 * Most Rendobar responses are `{ data: <payload> }`. A few — `POST /assets` in
 * particular — put `data` beside a sibling discriminator instead, so callers
 * that want the whole response still get something useful when `data` is absent.
 */
export function unwrapData(response: JsonValue | undefined): JsonObject | undefined {
	return objectAt(response, 'data') ?? asObject(response);
}

// ── n8n parameter bags ────────────────────────────────────────────────────
//
// Values read back with `getNodeParameter` are typed as a broad union (a
// collection, a resource-mapper value, a resource locator, …). These read one
// key off such a value without assuming which member of the union it is.

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
 * Narrows a value of unknown shape to a JSON object. Everything that reaches
 * this came from a node parameter the user filled in through the n8n UI, which
 * stores only JSON-serialisable values, so once the guard has established it is
 * a plain object its members are `JsonValue`s by construction. This is the only
 * place in the package that trusts a parameter value without checking it
 * member by member.
 */
function asParameterObject(value: unknown): JsonObject | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	return value as JsonObject;
}

export function readObject(source: unknown, key: string): JsonObject | undefined {
	return asParameterObject(valueAt(source, key));
}

/**
 * Reads a parameter the user may have typed as JSON text or produced from an
 * expression. Returns a discriminated result instead of throwing so the caller
 * can raise the error naming its own parameter.
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
			// `JSON.parse` is typed `any`; whatever it returns is a `JsonValue` by
			// definition of the grammar it accepts.
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
