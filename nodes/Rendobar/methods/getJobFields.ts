import type {
	ILoadOptionsFunctions,
	ResourceMapperField,
	ResourceMapperFields,
	FieldType,
} from 'n8n-workflow';
import { rendobarApiRequest } from '../shared/transport';

type ConnectorField = {
	name: string;
	label: string;
	type: 'string' | 'number' | 'boolean' | 'options' | 'json';
	required: boolean;
	default?: unknown;
	options?: Array<{ label: string; value: string }>;
};

type SchemaResponse = {
	data: { type: string; fields: ConnectorField[] };
};

// Our connector field types map onto n8n's resource-mapper field types. Nested
// params (type "json") become an object field; the user edits raw JSON.
const TYPE_MAP: Record<ConnectorField['type'], FieldType> = {
	string: 'string',
	number: 'number',
	boolean: 'boolean',
	options: 'options',
	json: 'object',
};

function isPrimitive(v: unknown): v is string | number | boolean {
	return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

// Loads the parameter fields for the selected job type from
// GET /jobs/types/:type/schema. n8n calls this whenever the Job Type changes,
// so the form always matches the live schema with no node release.
export async function getJobFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
	const jobType = this.getNodeParameter('jobType', undefined, {
		extractValue: true,
	}) as string;

	if (!jobType) return { fields: [] };

	const response = (await rendobarApiRequest.call(
		this,
		'GET',
		`/jobs/types/${encodeURIComponent(jobType)}/schema`,
	)) as SchemaResponse;

	const fields: ResourceMapperField[] = (response.data?.fields ?? []).map((f) => ({
		id: f.name,
		displayName: f.label,
		required: f.required,
		display: true,
		defaultMatch: false,
		type: TYPE_MAP[f.type] ?? 'string',
		options: f.options?.map((o) => ({ name: o.label, value: o.value })),
		defaultValue: isPrimitive(f.default) ? f.default : null,
	}));

	return { fields };
}
