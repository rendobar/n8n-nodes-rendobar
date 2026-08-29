import type {
	FieldType,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	ResourceMapperField,
	ResourceMapperFields,
} from 'n8n-workflow';
import { rendobarApiRequest } from '../shared/transport';
import { arrayAt, isJsonObject, objectAt, objectsAt, booleanAt, stringAt } from '../shared/json';
import type { JsonObject, JsonValue } from '../shared/json';

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

/** What n8n pre-fills a field with, or null when the job type names no default. */
type DefaultValue = string | number | boolean | null;

function defaultValueOf(value: unknown): DefaultValue {
	return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
		? value
		: null;
}

/**
 * Whether n8n would put a value in this parameter that the user never chose.
 *
 * n8n draws a `number` parameter with element-plus's InputNumber, which turns an
 * empty input into 0 as it mounts and writes that back through the resource
 * mapper (`element-plus/es/components/input-number/src/input-number2.mjs`,
 * onMounted: `if (!isNumber(modelValue) && modelValue != null) emit(
 * UPDATE_MODEL_EVENT, Number(modelValue))`, reached because
 * `MappingFields.vue` hands an unset field to the input as `''`). Merely
 * opening the panel is enough: a `timeout` nobody touched reaches `POST /jobs`
 * as 0, which every job type refuses, and an untouched `seed` reaches it as 0,
 * which no job type refuses — it silently pins a generation the user meant to
 * leave random.
 *
 * Nothing in what n8n saves tells that 0 apart from one the user typed: the
 * schema entry it writes alongside is identical either way. So the fix cannot
 * be to drop zeros on the way out — it has to be to stop n8n inventing one.
 * A parameter the job type gives a default for is safe, because n8n pre-fills
 * the input with that number and it never mounts empty. The rest are offered
 * through n8n's 'Add parameter' menu instead of being drawn, which is n8n's own
 * idiom for an optional field and leaves the panel honest: what it shows is
 * exactly what gets sent.
 */
function n8nWouldInventAValue(
	type: FieldType,
	required: boolean,
	defaultValue: DefaultValue,
): boolean {
	return type === 'number' && !required && defaultValue === null;
}

/**
 * Turns one entry of `GET /jobs/types/:type/schema`'s flat field list into the
 * field n8n maps. An entry with no name is dropped: there is nothing to map to.
 */
export function toMapperField(field: JsonObject): ResourceMapperField | undefined {
	const name = stringAt(field, 'name');
	if (name === undefined) return undefined;

	const type = TYPE_MAP[stringAt(field, 'type') ?? 'string'] ?? 'string';
	const required = booleanAt(field, 'required') ?? false;
	const defaultValue = defaultValueOf(field.default);
	const options: INodePropertyOptions[] = objectsAt(field, 'options').flatMap((option) => {
		const value = stringAt(option, 'value');
		if (value === undefined) return [];
		return [{ name: stringAt(option, 'label') ?? value, value }];
	});

	// The ResourceMapper keys rows by `id`, and `name` is not unique: a
	// discriminated union emits one entry per shape, so image.generate returns
	// FOUR `steps` fields with different bounds. Keyed on `name` the UI showed
	// four identical-looking rows, one of which arbitrarily won.
	//
	// `key` is unique and is `name` or `name__<digest>`. Older API responses have
	// no `key`, so fall back to `name` rather than dropping the field.
	const key = stringAt(field, 'key') ?? name;

	return {
		id: key,
		displayName: stringAt(field, 'label') ?? name,
		required,
		display: true,
		defaultMatch: false,
		type,
		...(options.length > 0 ? { options } : {}),
		defaultValue,
		...(n8nWouldInventAValue(type, required, defaultValue) ? { removed: true } : {}),
	};
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
			const mapped = toMapperField(field);
			return mapped === undefined ? [] : [mapped];
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
