import type { ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';
import { booleanAt, stringAt } from '../shared/json';
import { connectionLabel, loadStorageConnections } from '../shared/storage';

/**
 * The connections a job can deliver to, for the Destinations option. A
 * read-only connection is left out because the API refuses it as a destination.
 * One still being set up is left out because it cannot write yet.
 */
export async function getStorageDestinations(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const options = (await loadStorageConnections.call(this)).flatMap((connection) => {
		const id = stringAt(connection, 'id');
		if (id === undefined || stringAt(connection, 'access') === 'read' || booleanAt(connection, 'pending') === true) return [];
		return [{ name: connectionLabel(connection), value: id }];
	});
	return options.sort((left, right) => left.name.localeCompare(right.name));
}
