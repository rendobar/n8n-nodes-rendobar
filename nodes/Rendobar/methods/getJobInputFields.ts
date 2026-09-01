import type { ILoadOptionsFunctions, ResourceMapperField, ResourceMapperFields } from 'n8n-workflow';
import { rendobarApiRequest } from '../shared/transport';
import { booleanAt, objectAt, objectsAt, stringAt } from '../shared/json';
import type { JsonObject } from '../shared/json';

/**
 * The media a job reads, as resource-mapper fields.
 *
 * This exists because the schema endpoint used to describe parameters only, so
 * the media had to be hand-written into 'Inputs (JSON)': a user had to know
 * that compress.target wants a key called `source` before anything would run.
 * `GET /jobs/types/:type/schema` now also returns an `inputs` descriptor, and
 * this turns it into the same kind of form the parameters already get.
 *
 * Every input is a URL, so every field is a string. A file picker is
 * deliberately not offered here: n8n would have to hold the whole file to hand
 * it over, and Rendobar fetches the URL itself. The File resource's Upload
 * operation covers bytes that only exist inside the workflow, and its output is
 * a URL to put in one of these fields.
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

/**
 * The descriptor turned into fields, with the three cases that produce none.
 *
 * Pure and exported so it can be tested without a transport, which is how the
 * rest of this node's method logic is covered.
 */
export function inputFieldsFrom(
	inputs: JsonObject | undefined,
	jobType: string,
): ResourceMapperFields {
	// An API deployed before the inputs descriptor. Saying so beats an empty
	// form that looks like the job needs no media.
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

/**
 * Loads the input fields for the chosen job type. n8n calls this whenever Job
 * Type changes, so the form always matches the live contract with no release of
 * this node.
 */
export async function getJobInputFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
	const selected = this.getNodeParameter('jobType', undefined, { extractValue: true });
	const jobType = typeof selected === 'string' ? selected.trim() : '';

	if (jobType === '') {
		return { fields: [], emptyFieldsNotice: 'Choose a job type above and its inputs load here.' };
	}

	const response = await rendobarApiRequest.call(this, {
		method: 'GET',
		path: `/jobs/types/${encodeURIComponent(jobType)}/schema`,
		idempotent: true,
	});

	return inputFieldsFrom(objectAt(objectAt(response, 'data'), 'inputs'), jobType);
}
