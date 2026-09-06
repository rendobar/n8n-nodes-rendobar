import type { ILoadOptionsFunctions, ResourceMapperField, ResourceMapperFields } from 'n8n-workflow';
import { rendobarApiRequest } from '../shared/transport';
import { booleanAt, objectAt, objectsAt, stringAt } from '../shared/json';
import type { JsonObject } from '../shared/json';

/**
 * The media a job reads, as resource-mapper fields.
 *
 * Every input is a URL, so every field is a string. No file picker: n8n would
 * have to hold the whole file and Rendobar fetches the URL itself. File > Upload
 * covers bytes that only exist inside the workflow and returns a URL for here.
 */
function toInputField(input: JsonObject): ResourceMapperField | undefined {
	const name = stringAt(input, 'name');
	if (name === undefined) return undefined;

	const required = booleanAt(input, 'required') ?? false;
	const isList = booleanAt(input, 'multiple') ?? false;
	const description = stringAt(input, 'description');

	return {
		id: name,
		displayName: stringAt(input, 'label') ?? name,
		required,
		display: true,
		defaultMatch: false,
		// A list of URLs is mapped as an array; everything else is one URL.
		type: isList ? 'array' : 'string',
		defaultValue: null,
		...(description === undefined ? {} : { description }),
	};
}

/** The descriptor turned into fields. Exported pure so it tests without a transport. */
export function inputFieldsFrom(
	inputs: JsonObject | undefined,
	jobType: string,
): ResourceMapperFields {
	// An API deployed before the inputs descriptor. Say so rather than show an
	// empty form that reads as "needs no media".
	if (inputs === undefined) {
		return {
			fields: [],
			emptyFieldsNotice:
				"This Rendobar deployment does not describe job inputs yet. Set 'Specify Inputs' to 'Using JSON' and give it an object keyed by input name.",
		};
	}

	// ffmpeg and ffprobe stage each input as a file named by its key and the
	// command refers to it by that name, so there is no fixed set to draw.
	if (booleanAt(inputs, 'variadic') === true) {
		return {
			fields: [],
			emptyFieldsNotice: `The '${jobType}' job type names its input files in the command itself. Set 'Specify Inputs' to 'Using JSON' and give it a map of filename to URL, for example { "in.mp4": "https://example.com/clip.mp4" }.`,
		};
	}

	const fields: ResourceMapperField[] = objectsAt(inputs, 'fields').flatMap((input) => {
		const mapped = toInputField(input);
		return mapped === undefined ? [] : [mapped];
	});

	if (fields.length > 0) return { fields };

	return {
		fields: [],
		emptyFieldsNotice: `The '${jobType}' job type reads no input files. Its media, if any, is named in the parameters.`,
	};
}

/** Called whenever Job Type changes, so the form tracks the live contract. */
export async function getJobInputFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
	const selected = this.getNodeParameter('jobType', undefined, { extractValue: true });
	const jobType = typeof selected === 'string' ? selected.trim() : '';

	// See getJobFields: nothing to say until a job type is chosen.
	if (jobType === '') return { fields: [] };

	const response = await rendobarApiRequest.call(this, {
		method: 'GET',
		path: `/jobs/types/${encodeURIComponent(jobType)}/schema`,
		idempotent: true,
	});

	return inputFieldsFrom(objectAt(objectAt(response, 'data'), 'inputs'), jobType);
}
