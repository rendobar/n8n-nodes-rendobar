import type { ILoadOptionsFunctions, INodeListSearchItems, INodeListSearchResult } from 'n8n-workflow';
import { rendobarApiRequest } from '../shared/transport';
import { objectsAt, stringAt } from '../shared/json';

/**
 * Powers the Job Type list. Discovered live from `GET /jobs/types`, so a job
 * type Rendobar adds shows up without a release of this node.
 */
export async function getJobTypes(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const response = await rendobarApiRequest.call(this, {
		method: 'GET',
		path: '/jobs/types',
		idempotent: true,
	});

	const term = filter?.trim().toLowerCase();

	const results: INodeListSearchItems[] = objectsAt(response, 'data').flatMap((entry) => {
		const type = stringAt(entry, 'type');
		if (type === undefined) return [];

		const summary = stringAt(entry, 'summary');
		if (term !== undefined && term !== '' && !`${type} ${summary ?? ''}`.toLowerCase().includes(term)) {
			return [];
		}

		return [
			{
				name: summary === undefined ? type : `${type}: ${summary}`,
				value: type,
			},
		];
	});

	// n8n's UI guidance is to sort lists alphabetically; the endpoint makes no
	// promise about order.
	results.sort((left, right) => left.name.localeCompare(right.name));

	return { results };
}
