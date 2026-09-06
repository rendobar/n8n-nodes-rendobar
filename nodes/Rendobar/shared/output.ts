import type { INodeExecutionData } from 'n8n-workflow';
import { objectAt, type JsonObject } from './json';

// The node is `usableAsTool`, so n8n's UX guidelines require the three-mode
// `Output` parameter rather than a `Simplify` boolean.
export type OutputMode = 'simplified' | 'raw' | 'selected';

// The projection behind Output -> Simplified.
//
// Eleven names, but an item never holds eleven fields: the job response is a
// union on `status`, so `data`/`file`/`files`/`expiresAt` exist only on a
// complete job and `error` only on a failed one. `pickJobFields` keeps whichever
// is present, which tops out at ten. `test/output.test.js` pins it per status.
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

// The same three modes for the File resource. The default keeps where the file
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

// One output shape for every job type on completion, lifted to the top of the
// item so downstream nodes need no per-job-type narrowing:
//   data      job-type-specific computed result, null for file-only jobs.
//   file      headline result: one output file or a stream manifest
//             (.m3u8/.mpd), always one of `files`. Null for data-only jobs.
//   files     every produced file. [] for data-only jobs.
//   expiresAt Unix ms when the file URLs expire, null when there are none.
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

// Only the requested keys the job actually has, so a running job does not grow
// null placeholders.
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
	// n8n's UX guidelines require Selected Fields to always include the ID, so an
	// agent can come back for the rest of the record.
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

// camelCase -> Title Case for the Fields dropdown. The caller overrides acronyms
// n8n's style guide spells a specific way.
export function titleCaseFieldName(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\b\w/g, (character) => character.toUpperCase());
}
