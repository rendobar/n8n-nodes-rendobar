import type { INodeExecutionData } from 'n8n-workflow';
import { objectAt, type JsonObject } from './json';

// How much of a job to put on the item. The node is `usableAsTool`, so n8n's
// UX guidelines require the three-mode `Output` parameter rather than a plain
// `Simplify` boolean: an unfiltered job carries ~33 top-level fields, which
// blows out an agent's context window for no benefit.
export type OutputMode = 'simplified' | 'raw' | 'selected';

// The projection behind Output -> Simplified. `data`/`file`/`files`/`expiresAt`
// come from the unified output contract, `error` from the failure contract, and
// the rest are the fields a workflow actually branches on.
//
// The list holds eleven names but an item never holds eleven fields: Rendobar's
// job response is a discriminated union on `status`, so `output` (and with it
// `data`/`file`/`files`/`expiresAt`) exists only on a complete job and `error`
// only on a failed one. `pickJobFields` keeps whichever the job actually has,
// which tops out at ten. `test/output.test.js` pins that for every status.
export const SIMPLIFIED_FIELDS = [
	'id',
	'type',
	'status',
	'error',
	'cost',
	'data',
	'file',
	'files',
	'expiresAt',
	'createdAt',
	'completedAt',
] as const;

// The ceiling the n8n UX guidelines put on a simplified item.
export const SIMPLIFIED_FIELD_LIMIT = 10;

// Everything a job item can carry, for Output -> Selected Fields. Kept sorted
// so the dropdown reads alphabetically. `data`, `file`, `files` and
// `expiresAt` are the lifted output fields; the rest come straight off the job.
export const JOB_FIELDS = [
	'bootState',
	'callback',
	'client',
	'completedAt',
	'cost',
	'createdAt',
	'data',
	'dispatchedAt',
	'error',
	'eta',
	'expiresAt',
	'file',
	'files',
	'id',
	'idempotencyKey',
	'inputs',
	'logsAvailable',
	'mediaType',
	'metricsAvailable',
	'model',
	'orgId',
	'output',
	'outputCategory',
	'params',
	'progress',
	'region',
	'resourcesAvailable',
	'retentionExpiresAt',
	'retryCount',
	'settledAt',
	'source',
	'startedAt',
	'status',
	'steps',
	'timeoutMs',
	'type',
	'webUrl',
] as const;

// The same three modes for the File resource. An asset carries 21 fields, most
// of which describe how Rendobar stores the file rather than anything a
// workflow acts on, so the default keeps the ones that matter: where the file
// is, what it is, and how long the link lasts.
export const SIMPLIFIED_ASSET_FIELDS = [
	'id',
	'url',
	'filename',
	'contentType',
	'mediaType',
	'sizeBytes',
	'status',
	'expiresAt',
	'createdAt',
] as const;

// Everything an asset can carry, for Output -> Selected Fields. Sorted, like
// JOB_FIELDS, so the dropdown reads alphabetically.
export const ASSET_FIELDS = [
	'checksum',
	'contentType',
	'createdAt',
	'createdBy',
	'declaredSize',
	'etag',
	'expiresAt',
	'filename',
	'id',
	'kind',
	'lifecycle',
	'mediaType',
	'metadata',
	'orgId',
	'region',
	'scope',
	'sizeBytes',
	'source',
	'status',
	'updatedAt',
	'url',
] as const;

// Every Rendobar job, for every job type, returns ONE output shape when it
// completes:
//   data      — job-type-specific computed result (probe/detections/transcript),
//               or null for file-only jobs.
//   file      — the headline result: a single output file OR a stream manifest
//               (.m3u8/.mpd). Always one of `files`. Null for data-only jobs/sets.
//   files     — every produced file, the complete list. [] for data-only jobs.
//   expiresAt — Unix ms when the file URLs expire, or null when there are none.
// Lifting them to the top of the item gives downstream nodes clean, predictable
// fields without digging into `output` (and without narrowing per job type).
export function liftJobOutput(job: JsonObject): JsonObject {
	const json: JsonObject = { ...job };
	const output = objectAt(job, 'output');
	if (output) {
		json.data = output.data ?? null;
		json.file = output.file ?? null;
		json.files = output.files ?? [];
		json.expiresAt = output.expiresAt ?? null;
	}
	return json;
}

// Keeps only the requested keys, and only the ones the job actually has, so a
// running job doesn't grow a wall of null placeholders it never had.
export function pickJobFields(json: JsonObject, fields: readonly string[]): JsonObject {
	const picked: JsonObject = {};
	for (const field of fields) {
		if (field in json) picked[field] = json[field];
	}
	return picked;
}

function project(
	json: JsonObject,
	mode: OutputMode,
	selected: string[],
	simplified: readonly string[],
): JsonObject {
	if (mode === 'raw') return json;
	if (mode === 'simplified') return pickJobFields(json, simplified);
	// `id` is always included, whether or not the user picked it, so an agent can
	// come back for the rest of the record later. This is what n8n's UX
	// guidelines require of the Selected Fields mode.
	return pickJobFields(json, ['id', ...selected.filter((field) => field !== 'id')]);
}

export function buildJobJson(
	job: JsonObject,
	mode: OutputMode = 'raw',
	selected: string[] = [],
): JsonObject {
	return project(liftJobOutput(job), mode, selected, SIMPLIFIED_FIELDS);
}

export function buildJobItem(
	job: JsonObject,
	itemIndex: number,
	mode: OutputMode = 'raw',
	selected: string[] = [],
): INodeExecutionData {
	return { json: buildJobJson(job, mode, selected), pairedItem: { item: itemIndex } };
}

export function buildAssetJson(
	asset: JsonObject,
	mode: OutputMode = 'raw',
	selected: string[] = [],
): JsonObject {
	return project({ ...asset }, mode, selected, SIMPLIFIED_ASSET_FIELDS);
}

export function buildAssetItem(
	asset: JsonObject,
	itemIndex: number,
	mode: OutputMode = 'raw',
	selected: string[] = [],
): INodeExecutionData {
	return { json: buildAssetJson(asset, mode, selected), pairedItem: { item: itemIndex } };
}

// camelCase -> Title Case, for the Fields dropdown labels. Acronyms n8n's style
// guide spells a specific way are overridden by the caller.
export function titleCaseFieldName(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\b\w/g, (character) => character.toUpperCase());
}
