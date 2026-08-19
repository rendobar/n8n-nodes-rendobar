import type { ILoadOptionsFunctions, INodeListSearchItems, INodeListSearchResult } from 'n8n-workflow';
import { rendobarApiRequest } from '../shared/transport';
import { numberAt, objectAt, objectsAt, stringAt, type JsonObject } from '../shared/json';

// `GET /jobs` caps a page at 100 and takes no free-text search, so the list is
// paged newest-first and any typed term is matched against the page in hand.
// n8n asks for the next page through the pagination token as the user scrolls.
const PAGE_SIZE = 100;

/** Turns a job into the one line the list shows: what it was and how it ended. */
export function jobSearchLabel(job: JsonObject): string | undefined {
	const id = stringAt(job, 'id');
	if (id === undefined) return undefined;

	const type = stringAt(job, 'type');
	const status = stringAt(job, 'status');
	const createdAt = numberAt(job, 'createdAt');
	const created = createdAt === undefined ? undefined : new Date(createdAt).toISOString().slice(0, 16).replace('T', ' ');

	return [type, status, created, id].filter((part) => part !== undefined && part !== '').join(' · ');
}

export function matchesJobSearch(job: JsonObject, term: string): boolean {
	const haystack = [stringAt(job, 'id'), stringAt(job, 'type'), stringAt(job, 'status')]
		.filter((part): part is string => typeof part === 'string')
		.join(' ')
		.toLowerCase();
	return haystack.includes(term);
}

/**
 * Powers the Job Type-style list on the 'Job ID' parameter, so a job can be
 * picked from recent history instead of pasting an ID.
 */
export async function getJobs(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const offset = Number(paginationToken ?? '0');
	const start = Number.isFinite(offset) && offset > 0 ? offset : 0;

	const response = await rendobarApiRequest.call(this, {
		method: 'GET',
		path: '/jobs',
		qs: { limit: PAGE_SIZE, offset: start },
		idempotent: true,
	});

	const jobs = objectsAt(response, 'data');
	const term = filter?.trim().toLowerCase() ?? '';

	const results: INodeListSearchItems[] = jobs.flatMap((job) => {
		if (term !== '' && !matchesJobSearch(job, term)) return [];

		const id = stringAt(job, 'id');
		const name = jobSearchLabel(job);
		if (id === undefined || name === undefined) return [];

		const url = stringAt(job, 'webUrl');
		return [{ name, value: id, ...(url === undefined ? {} : { url }) }];
	});

	// Newest first is what the endpoint already returns, and it is the order a
	// user picking a recent job expects, so the page is left as it arrives.
	const total = numberAt(objectAt(response, 'meta'), 'total');
	const seen = start + jobs.length;
	const more = jobs.length === PAGE_SIZE && (total === undefined || seen < total);

	return { results, ...(more ? { paginationToken: String(seen) } : {}) };
}
