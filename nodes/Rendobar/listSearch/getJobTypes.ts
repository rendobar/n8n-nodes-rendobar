import type {
	ILoadOptionsFunctions,
	INodeListSearchItems,
	INodeListSearchResult,
} from 'n8n-workflow';
import { rendobarApiRequest } from '../shared/transport';

type JobType = {
	type: string;
	summary?: string;
	tag?: string;
};

type JobTypesResponse = {
	data: JobType[];
};

// Powers the Job Type dropdown. Discovered live from GET /jobs/types, so a new
// job type appears in the dropdown without a node release.
export async function getJobTypes(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const response = (await rendobarApiRequest.call(this, 'GET', '/jobs/types')) as JobTypesResponse;

	const term = filter?.toLowerCase();
	const results: INodeListSearchItems[] = (response.data ?? [])
		.filter((t) => !term || t.type.toLowerCase().includes(term) || t.summary?.toLowerCase().includes(term))
		.map((t) => ({
			name: t.summary ? `${t.type}: ${t.summary}` : t.type,
			value: t.type,
		}));

	return { results };
}
