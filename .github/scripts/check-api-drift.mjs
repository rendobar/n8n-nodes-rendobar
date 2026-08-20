#!/usr/bin/env node
// Compares the live Rendobar platform surface against what this node actually
// implements, and prints a markdown report on stdout.
//
// It REPORTS only. It never edits node source, never opens a code PR, and
// never calls a write endpoint. The workflow that runs it only files an issue.
//
// Two halves of the node behave differently and the report keeps them apart:
//
//   Self-updating — the job-type dropdown (GET /jobs/types) and the parameter
//   form (GET /jobs/types/:type/schema) are fetched live at design time, so a
//   new job type or a new parameter reaches users with no node release. Those
//   are reported as context, not as work.
//
//   Hand-written — operations, the credential, the trigger's event list, and
//   the request bodies are compiled into the published package. Those only
//   change when someone edits the node, so that is where drift accumulates.
//
// The node's own surface is parsed out of nodes/ and credentials/ rather than
// listed here, so this file cannot itself go stale.
//
// Usage:
//   node .github/scripts/check-api-drift.mjs           # markdown to stdout
//   node .github/scripts/check-api-drift.mjs --json    # machine-readable
//
// Exit code is 0 whether or not drift exists (a report is not a failure); it is
// non-zero only when the live API could not be read. When drift exists the
// report ends with the marker line DRIFT_FOUND=true.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.RENDOBAR_API_URL ?? 'https://api.rendobar.com';
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

// Which parts of the platform an n8n automation node is expected to cover.
// This is a scoping decision, not a list of what the node implements — that is
// parsed from source below. A tag in neither list is surfaced loudly as a new
// API area rather than silently dropped.
const IN_SCOPE_TAGS = new Set(['Jobs', 'Assets', 'Webhooks', 'Models', 'Sharing']);
const OUT_OF_SCOPE_TAGS = new Set([
	'Billing', // dashboard/account surface, not workflow automation
	'Organizations',
	'API Keys',
	'Upload Sessions', // share-link browser flow
]);

// Endpoints inside an out-of-scope tag that the node deliberately DOES expose.
// Without this, the report keeps listing them as unimplemented and the drift
// signal degrades into noise the reader learns to skip.
const OUT_OF_SCOPE_EXCEPTIONS = new Set([
	'GET /billing/state', // Account -> Get. The balance the balance.* triggers fire on.
]);

// ─── live platform ────────────────────────────────────────────────────────────

async function getJson(path) {
	const res = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } });
	if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${res.statusText}`);
	return res.json();
}

// `/jobs/{id}` and `/jobs/:id` both mean the same route; the live spec uses
// both styles. Collapse every parameter to one token so paths compare.
function normalizePath(path) {
	return path
		.replace(/\{[^}]*\}/g, '{param}')
		.replace(/(^|\/):[^/]+/g, '$1{param}')
		.replace(/\/$/, '');
}

function liveOperations(spec) {
	const ops = [];
	for (const [path, item] of Object.entries(spec.paths ?? {})) {
		for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
			const op = item[method];
			if (!op) continue;
			ops.push({
				key: `${method.toUpperCase()} ${normalizePath(path)}`,
				method: method.toUpperCase(),
				path,
				tags: op.tags ?? [],
				summary: op.summary ?? op.description ?? '',
				requiredBody: requiredBodyFields(op),
			});
		}
	}
	return ops.sort((a, b) => a.key.localeCompare(b.key));
}

function requiredBodyFields(op) {
	const schema = op.requestBody?.content?.['application/json']?.schema;
	return new Set(schema?.required ?? []);
}

function liveWebhookEvents(spec) {
	const schema = spec.paths?.['/webhooks/endpoints']?.post?.requestBody?.content?.[
		'application/json'
	]?.schema;
	const events = schema?.properties?.subscribedEvents?.items?.enum;
	return new Set(events ?? []);
}

// ─── node surface, parsed from source ─────────────────────────────────────────

function sourceFiles() {
	const files = [];
	const walk = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) walk(full);
			else if (full.endsWith('.ts')) files.push(full);
		}
	};
	walk(join(REPO_ROOT, 'nodes'));
	walk(join(REPO_ROOT, 'credentials'));
	return files.sort();
}

// Returns the balanced block that starts at the opening bracket at `from`.
function balanced(text, from, open, close) {
	let depth = 0;
	for (let i = from; i < text.length; i++) {
		if (text[i] === open) depth++;
		else if (text[i] === close && --depth === 0) return text.slice(from, i + 1);
	}
	return '';
}

// Index of the `{` that opens the object literal containing `index`.
function enclosingObject(text, index) {
	let depth = 0;
	for (let i = index; i >= 0; i--) {
		if (text[i] === '}') depth++;
		else if (text[i] === '{') {
			if (depth === 0) return i;
			depth--;
		}
	}
	return -1;
}

// `const path = `/jobs/${...}`;` then `` `${path}/cancel` `` — resolve the local
// binding so the second reads as /jobs/{param}/cancel and not {param}/cancel.
function templateBindings(source) {
	const bindings = new Map();
	for (const m of source.matchAll(/const\s+(\w+)\s*=\s*`([^`]*)`/g)) bindings.set(m[1], m[2]);
	return bindings;
}

function resolveLiteral(literal, bindings) {
	let body = literal.slice(1, -1); // strip the quote or backtick
	for (let pass = 0; pass < 2; pass++) {
		body = body.replace(/\$\{\s*(\w+)\s*\}/g, (whole, name) =>
			bindings.has(name) ? bindings.get(name) : whole,
		);
	}
	return normalizePath(body.replace(/\$\{[^}]*\}/g, '{param}'));
}

// Top-level keys of an object literal, including ES shorthand (`{ filename }`).
function objectKeys(block) {
	const inner = block.slice(1, -1);
	const keys = [];
	let depth = 0;
	for (const line of inner.split('\n')) {
		const trimmed = line.trim();
		if (depth === 0) {
			const m = trimmed.match(/^([A-Za-z_$][\w$]*)\s*(:|,\s*$|$)/);
			if (m) keys.push(m[1]);
		}
		for (const ch of line) {
			if (ch === '{' || ch === '[' || ch === '(') depth++;
			else if (ch === '}' || ch === ']' || ch === ')') depth--;
		}
	}
	return keys;
}

// Every API call the node makes, as METHOD + normalized path. Covers the shared
// transport helper (all runtime + design-time calls) and the credential test.
function nodeCalls(files) {
	const calls = new Map(); // key -> { where, bodyKeys }

	for (const file of files) {
		const source = readFileSync(file, 'utf8');
		const rel = file.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');
		const bindings = templateBindings(source);

		const callRe = /rendobarApiRequest\.call\(\s*this\s*,\s*'([A-Z]+)'\s*,\s*(`[^`]*`|'[^']*')/g;
		for (const m of source.matchAll(callRe)) {
			const key = `${m[1]} ${resolveLiteral(m[2], bindings)}`;
			// A body argument, when present, is the next thing after the path.
			const after = source.slice(m.index + m[0].length);
			const bodyStart = after.match(/^\s*,\s*(?=\{)/);
			const bodyKeys = bodyStart
				? objectKeys(balanced(after, bodyStart[0].length, '{', '}'))
				: [];
			calls.set(key, { where: rel, bodyKeys });
		}

		// The credential test request is a plain object, not a transport call.
		const testAt = source.indexOf('test: ICredentialTestRequest');
		if (testAt !== -1) {
			const block = balanced(source, source.indexOf('{', testAt), '{', '}');
			const url = block.match(/\burl:\s*'([^']+)'/)?.[1];
			const method = block.match(/\bmethod:\s*'([A-Z]+)'/)?.[1] ?? 'GET';
			if (url) calls.set(`${method} ${normalizePath(url)}`, { where: rel, bodyKeys: [] });
		}
	}

	return calls;
}

// The `value:` entries of every `options`/`multiOptions` property with this
// name. A resource/operation split declares `operation` more than once — one
// per resource — so union them all rather than taking the first.
function optionValues(source, propertyName) {
	const values = new Set();
	for (const m of source.matchAll(new RegExp(`name:\\s*'${propertyName}'`, 'g'))) {
		const start = enclosingObject(source, m.index);
		if (start === -1) continue;
		const property = balanced(source, start, '{', '}');
		const optionsAt = property.indexOf('options: [');
		if (optionsAt === -1) continue;
		const block = balanced(property, property.indexOf('[', optionsAt), '[', ']');
		for (const v of block.matchAll(/value:\s*'([^']+)'/g)) values.add(v[1]);
	}
	return [...values].sort();
}

// A moved or renamed file must not crash the weekly run, and it must not
// silently turn every live event into a false finding either. Missing files
// are reported as what they are: a check that could not run.
const unparsed = [];

function readSource(relative) {
	try {
		return readFileSync(join(REPO_ROOT, relative), 'utf8');
	} catch {
		unparsed.push(
			`- \`${relative}\` was not found, so the checks that read it were skipped — update the path in \`.github/scripts/check-api-drift.mjs\``,
		);
		return '';
	}
}

// ─── report ───────────────────────────────────────────────────────────────────

function bullets(lines) {
	return lines.length ? lines.join('\n') : '';
}

async function main() {
	const asJson = process.argv.includes('--json');

	const [spec, jobTypesResponse] = await Promise.all([
		getJson('/openapi.json'),
		getJson('/jobs/types'),
	]);

	const files = sourceFiles();
	if (files.length === 0) throw new Error('No node source found — is this the right repo root?');

	const calls = nodeCalls(files);
	const live = liveOperations(spec);
	const liveKeys = new Set(live.map((o) => o.key));

	const nodeSource = readSource('nodes/Rendobar/Rendobar.node.ts');
	const triggerSource = readSource('nodes/RendobarTrigger/RendobarTrigger.node.ts');
	const fieldsSource = readSource('nodes/Rendobar/methods/getJobFields.ts');

	const operations = optionValues(nodeSource, 'operation');
	const nodeEvents = new Set(optionValues(triggerSource, 'events'));
	const liveEvents = liveWebhookEvents(spec);
	if (triggerSource && nodeEvents.size === 0) {
		unparsed.push(
			'- The Rendobar Trigger event list could not be parsed out of the node, so the webhook-event comparison was skipped',
		);
	}

	const typeMapAt = fieldsSource.indexOf('const TYPE_MAP');
	const mappedFieldTypes = new Set(
		typeMapAt === -1
			? []
			: objectKeys(balanced(fieldsSource, fieldsSource.indexOf('{', typeMapAt), '{', '}')),
	);
	if (fieldsSource && typeMapAt === -1) {
		unparsed.push(
			'- `TYPE_MAP` was not found in the resource mapper, so the parameter field-type comparison was skipped',
		);
	}

	// ── findings that need a human ──

	const broken = [];
	const contract = [];

	// 1. The node calls something the live API no longer documents.
	for (const [key, { where }] of [...calls].sort()) {
		if (!liveKeys.has(key)) {
			broken.push(
				`- \`${key}\` is called by \`${where}\` but is not in the live OpenAPI spec — the node may be calling a removed or renamed endpoint`,
			);
		}
	}

	// 2. A request body is missing a field the live spec marks required.
	for (const [key, { where, bodyKeys }] of [...calls].sort()) {
		const op = live.find((o) => o.key === key);
		if (!op || op.requiredBody.size === 0) continue;
		const missing = [...op.requiredBody].filter((f) => !bodyKeys.includes(f)).sort();
		if (missing.length && bodyKeys.length) {
			contract.push(
				`- \`${key}\` requires ${missing.map((f) => `\`${f}\``).join(', ')}, which \`${where}\` does not send (it sends ${bodyKeys.map((f) => `\`${f}\``).join(', ')})`,
			);
		}
	}

	// 3. The trigger's hand-written event list vs the live enum.
	if (nodeEvents.size > 0 && liveEvents.size > 0) {
		for (const e of [...liveEvents].filter((x) => !nodeEvents.has(x)).sort()) {
			contract.push(
				`- Webhook event \`${e}\` exists in the API but the Rendobar Trigger node does not offer it`,
			);
		}
		for (const e of [...nodeEvents].filter((x) => !liveEvents.has(x)).sort()) {
			contract.push(
				`- Rendobar Trigger offers webhook event \`${e}\`, which the API no longer accepts`,
			);
		}
	}

	// 4. A parameter field type the resource mapper does not know. Unmapped
	//    types fall back to a plain string box, silently, for every job type
	//    that uses them — so this is worth catching even though the parameter
	//    form itself is fetched live.
	const liveTypes = (jobTypesResponse.data ?? []).map((t) => t.type).sort();
	const schemas = await Promise.all(
		liveTypes.map((t) => getJson(`/jobs/types/${encodeURIComponent(t)}/schema`)),
	);
	const seenFieldTypes = new Map(); // field type -> job types using it
	for (const [i, schema] of schemas.entries()) {
		for (const field of schema.data?.fields ?? []) {
			if (!seenFieldTypes.has(field.type)) seenFieldTypes.set(field.type, []);
			seenFieldTypes.get(field.type).push(liveTypes[i]);
		}
	}
	if (mappedFieldTypes.size > 0) {
		for (const [fieldType, users] of [...seenFieldTypes].sort()) {
			if (mappedFieldTypes.has(fieldType)) continue;
			contract.push(
				`- Parameter field type \`${fieldType}\` (used by ${users.join(', ')}) is missing from \`TYPE_MAP\` in \`nodes/Rendobar/methods/getJobFields.ts\` — those parameters silently render as plain text`,
			);
		}
	}

	// 5. The live-fetch contracts the self-updating half depends on.
	if (!Array.isArray(jobTypesResponse.data)) {
		broken.push(
			'- `GET /jobs/types` no longer returns a `data` array — the Job Type dropdown in `nodes/Rendobar/listSearch/getJobTypes.ts` will come up empty',
		);
	} else if (jobTypesResponse.data.some((t) => typeof t?.type !== 'string')) {
		broken.push('- `GET /jobs/types` returned an entry without a string `type`');
	}
	for (const [i, schema] of schemas.entries()) {
		if (!Array.isArray(schema.data?.fields)) {
			broken.push(
				`- \`GET /jobs/types/${liveTypes[i]}/schema\` no longer returns \`data.fields\` — the Parameters form in \`nodes/Rendobar/methods/getJobFields.ts\` will come up empty`,
			);
			break;
		}
	}

	// 6. A tag the scoping above has never heard of: a whole new API area.
	const unknownTags = new Set();
	for (const op of live) {
		for (const tag of op.tags) {
			if (!IN_SCOPE_TAGS.has(tag) && !OUT_OF_SCOPE_TAGS.has(tag)) unknownTags.add(tag);
		}
	}
	const newAreas = [...unknownTags].sort().map(
		(tag) =>
			`- New API area \`${tag}\` — decide whether the node should expose it, then add the tag to \`IN_SCOPE_TAGS\` or \`OUT_OF_SCOPE_TAGS\` in \`.github/scripts/check-api-drift.mjs\``,
	);

	// ── coverage (context, not a task) ──

	const inScopeGaps = [];
	const outOfScopeGaps = [];
	for (const op of live) {
		if (calls.has(op.key)) continue;
		// An endpoint the node deliberately exposes from an out-of-scope tag is not
		// a gap, and listing it as one trains the reader to skip this section.
		if (OUT_OF_SCOPE_EXCEPTIONS.has(op.key)) continue;
		const line = `- \`${op.key}\`${op.summary ? ` — ${op.summary}` : ''}`;
		const inScope = op.tags.some((t) => IN_SCOPE_TAGS.has(t) || unknownTags.has(t));
		(inScope ? inScopeGaps : outOfScopeGaps).push(line);
	}

	const actionable = [...broken, ...contract, ...newAreas, ...unparsed];
	const driftFound = actionable.length > 0 || inScopeGaps.length > 0;

	if (asJson) {
		console.log(
			JSON.stringify(
				{
					driftFound,
					broken,
					contract,
					newAreas,
					unparsed,
					inScopeGaps,
					outOfScopeGaps,
					operations,
					liveTypes,
					nodeCalls: [...calls.keys()].sort(),
				},
				null,
				2,
			),
		);
		return;
	}

	// Nothing here is timestamped on purpose: the workflow compares this report
	// byte-for-byte against the open issue and stays silent when it is unchanged.
	const out = [];
	out.push('# Node vs platform surface');
	out.push('');
	out.push(
		'Weekly comparison of the live Rendobar API against what this node implements.',
		'Generated by `.github/scripts/check-api-drift.mjs` from `GET /openapi.json` and',
		'`GET /jobs/types`, with the node side parsed out of `nodes/` and `credentials/`.',
		'',
		'**Reports only.** Nothing here is applied automatically — no source is edited and no',
		'code PR is opened. Decide per item whether the node should follow.',
		'',
	);

	if (broken.length) {
		out.push('## Broken against the live API');
		out.push('');
		out.push('The node calls or relies on something the platform no longer offers.');
		out.push('');
		out.push(bullets(broken), '');
	}

	if (contract.length) {
		out.push('## Contract drift');
		out.push('');
		out.push('Hand-written surface that no longer matches what the API describes.');
		out.push('');
		out.push(bullets(contract), '');
	}

	if (newAreas.length) {
		out.push('## New API areas');
		out.push('');
		out.push(bullets(newAreas), '');
	}

	if (unparsed.length) {
		out.push('## Checks that could not run');
		out.push('');
		out.push('The node moved and this report has not caught up.');
		out.push('');
		out.push(bullets(unparsed), '');
	}

	out.push('## Self-updating — no action');
	out.push('');
	out.push(
		'These track the platform on their own, with no node release. Listed so a change',
		'is still visible.',
		'',
	);
	out.push(`- Job types discovered live from \`GET /jobs/types\`: ${liveTypes.length}`);
	for (const t of liveTypes) out.push(`  - \`${t}\``);
	out.push(
		`- Parameter field types in use: ${[...seenFieldTypes.keys()].sort().map((t) => `\`${t}\``).join(', ')}`,
	);
	out.push('');

	out.push('## Coverage');
	out.push('');
	out.push(
		`Node operations today: ${operations.map((o) => `\`${o}\``).join(', ')}, plus the Rendobar Trigger node.`,
		'',
	);

	if (inScopeGaps.length) {
		out.push(
			`<details><summary>${inScopeGaps.length} automation endpoints the node has no operation for</summary>`,
			'',
			bullets(inScopeGaps),
			'',
			'</details>',
			'',
		);
	} else {
		out.push('Every automation endpoint the API exposes has a node operation.', '');
	}

	if (outOfScopeGaps.length) {
		out.push(
			`<details><summary>${outOfScopeGaps.length} account and dashboard endpoints (deliberately out of scope)</summary>`,
			'',
			bullets(outOfScopeGaps),
			'',
			'</details>',
			'',
		);
	}

	console.log(out.join('\n').trimEnd());
	console.log('');
	console.log(`DRIFT_FOUND=${driftFound}`);
}

main().catch((error) => {
	console.error(`API drift check failed: ${error.message}`);
	process.exit(1);
});
