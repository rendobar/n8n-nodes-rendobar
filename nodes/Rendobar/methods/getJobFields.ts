import type {
	FieldType,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	ResourceMapperField,
	ResourceMapperFields,
} from 'n8n-workflow';
import { rendobarApiRequest } from '../shared/transport';
import { booleanAt, objectAt, objectsAt, stringAt } from '../shared/json';

// Rendobar's connector field types map onto n8n's resource-mapper field types.
// A nested parameter (Rendobar type "json") becomes an object field, which n8n
// renders as a raw JSON editor.
const TYPE_MAP: Record<string, FieldType> = {
	string: 'string',
	number: 'number',
	boolean: 'boolean',
	options: 'options',
	json: 'object',
};

function defaultValueOf(value: unknown): string | number | boolean | null {
	return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
		? value
		: null;
}

/**
 * Loads the parameter fields for the chosen job type from
 * `GET /jobs/types/:type/schema`. n8n calls this whenever Job Type changes, so
 * the form always matches the live schema with no release of this node.
 */
export async function getJobFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
	// `extractValue` resolves the Resource Locator down to the job type name,
	// but the declared return type still spans every parameter shape.
	const selected = this.getNodeParameter('jobType', undefined, { extractValue: true });
	const jobType = typeof selected === 'string' ? selected.trim() : '';

	if (jobType === '') {
		return {
			fields: [],
			emptyFieldsNotice: "Choose a job type above and its parameters load here.",
		};
	}

	const response = await rendobarApiRequest.call(this, {
		method: 'GET',
		path: `/jobs/types/${encodeURIComponent(jobType)}/schema`,
		idempotent: true,
	});

	const fields: ResourceMapperField[] = objectsAt(objectAt(response, 'data'), 'fields').flatMap(
		(field) => {
			const name = stringAt(field, 'name');
			if (name === undefined) return [];

			const type = stringAt(field, 'type') ?? 'string';
			const options: INodePropertyOptions[] = objectsAt(field, 'options').flatMap((option) => {
				const value = stringAt(option, 'value');
				if (value === undefined) return [];
				return [{ name: stringAt(option, 'label') ?? value, value }];
			});

			return [
				{
					id: name,
					displayName: stringAt(field, 'label') ?? name,
					required: booleanAt(field, 'required') ?? false,
					display: true,
					defaultMatch: false,
					type: TYPE_MAP[type] ?? 'string',
					...(options.length > 0 ? { options } : {}),
					defaultValue: defaultValueOf(field.default),
				},
			];
		},
	);

	return {
		fields,
		...(fields.length === 0
			? {
					emptyFieldsNotice: `The '${jobType}' job type takes no parameters. Give it its files in 'Inputs (JSON)'.`,
				}
			: {}),
	};
}
