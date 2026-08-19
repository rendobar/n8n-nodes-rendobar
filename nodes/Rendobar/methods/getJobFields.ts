import type {
	FieldType,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	ResourceMapperField,
	ResourceMapperFields,
} from 'n8n-workflow';
import { rendobarApiRequest } from '../shared/transport';
import { arrayAt, isJsonObject, objectAt, objectsAt, booleanAt, stringAt } from '../shared/json';
import type { JsonValue } from '../shared/json';

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
 * Whether the job type has parameters that the flat field list could not carry.
 *
 * `GET /jobs/types/:type/schema` returns both a flat `fields` projection and the
 * whole `jsonSchema`. A job type whose parameters are a union — `compose` is an
 * `anyOf` of a timeline shape and a prompt shape, the two image types are
 * `oneOf` — has no single flat form, so the projection comes back empty while
 * the schema plainly describes required parameters. Telling that apart from a
 * job type that genuinely takes none is what decides whether the user is
 * pointed at 'Parameters (JSON)' or told there is nothing to fill in.
 */
export function describesParameters(jsonSchema: JsonValue | undefined): boolean {
	if (!isJsonObject(jsonSchema)) return false;

	for (const key of ['anyOf', 'oneOf', 'allOf']) {
		if ((arrayAt(jsonSchema, key) ?? []).length > 0) return true;
	}

	const properties = objectAt(jsonSchema, 'properties');
	return properties !== undefined && Object.keys(properties).length > 0;
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

	if (fields.length > 0) return { fields };

	return {
		fields,
		emptyFieldsNotice: describesParameters(objectAt(objectAt(response, 'data'), 'jsonSchema'))
			? `The '${jobType}' job type takes parameters that cannot be shown as a form. Set 'Specify Parameters' to 'Using JSON' and write them there.`
			: `The '${jobType}' job type takes no parameters. Give it its files in 'Inputs (JSON)'.`,
	};
}
