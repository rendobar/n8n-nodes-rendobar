import type { ILoadOptionsFunctions, INodeListSearchItems, INodeListSearchResult } from 'n8n-workflow';
import { stringAt } from '../shared/json';
import { connectionLabel, loadStorageConnections } from '../shared/storage';

/** Powers the Connection picker on Storage File › Get Many. Every connection can be listed, read-only ones too. */
export async function searchStorageConnections(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const term = filter?.trim().toLowerCase();
	const results: INodeListSearchItems[] = (await loadStorageConnections.call(this)).flatMap((connection) => {
		const id = stringAt(connection, 'id');
		if (id === undefined) return [];
		const name = connectionLabel(connection);
		if (term !== undefined && term !== '' && !name.toLowerCase().includes(term)) return [];
		return [{ name, value: id }];
	});
	results.sort((left, right) => left.name.localeCompare(right.name));
	return { results };
}
