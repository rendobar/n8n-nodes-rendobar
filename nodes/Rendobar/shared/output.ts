import type { IDataObject, INodeExecutionData } from 'n8n-workflow';

// How much of a job to put on the item. The node is `usableAsTool`, so n8n's
// UX guidelines require the three-mode `Output` parameter rather than a plain
// `Simplify` boolean: an unfiltered job carries ~32 top-level fields, which
// blows out an agent's context window for no benefit.
export type OutputMode = 'simplified' | 'raw' | 'selected';

// The <=10 field projection behind Output -> Simplified. `data`/`file`/`files`/
// `expiresAt` come from the unified output contract, the rest are the fields a
// workflow actually branches on.
export const SIMPLIFIED_FIELDS = [
	'id',
	'type',
	'status',
	'cost',
	'data',
	'file',
	'files',
	'expiresAt',
	'createdAt',
	'completedAt',
] as const;

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
export function liftJobOutput(job: IDataObject): IDataObject {
	const json: IDataObject = { ...job };
	const output = job.output as IDataObject | undefined;
	if (output) {
		json.data = output.data ?? null;
		json.file = (output.file as IDataObject | null) ?? null;
		json.files = (output.files as IDataObject[]) ?? [];
		json.expiresAt = output.expiresAt ?? null;
	}
	return json;
}

// Keeps only the requested keys, and only the ones the job actually has, so a
// running job doesn't grow a wall of null placeholders it never had.
export function pickJobFields(json: IDataObject, fields: readonly string[]): IDataObject {
	const picked: IDataObject = {};
	for (const field of fields) {
		if (field in json) picked[field] = json[field];
	}
	return picked;
}

export function buildJobJson(
	job: IDataObject,
	mode: OutputMode = 'raw',
	selected: string[] = [],
): IDataObject {
	const json = liftJobOutput(job);
	if (mode === 'raw') return json;
	if (mode === 'simplified') return pickJobFields(json, SIMPLIFIED_FIELDS);
	// `id` is always present so an agent can fetch the rest of the job later.
	return pickJobFields(json, ['id', ...selected.filter((f) => f !== 'id')]);
}

export function buildJobItem(
	job: IDataObject,
	itemIndex: number,
	mode: OutputMode = 'raw',
	selected: string[] = [],
): INodeExecutionData {
	return { json: buildJobJson(job, mode, selected), pairedItem: { item: itemIndex } };
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
