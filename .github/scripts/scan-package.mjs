#!/usr/bin/env node
// Runs n8n's own community-package scanner against THIS commit.
//
// Why this exists as a script instead of one `npx` line:
//
//   `npx @n8n/scan-community-package <package-name>` — the invocation n8n
//   documents — resolves a package from the npm registry, checks its
//   provenance attestation, and lints the attested source plus the published
//   tarball. It cannot be pointed at a working directory, so it can only ever
//   tell you about a version that is already public. On a pull request that is
//   the wrong answer: by then the bad version is published.
//
//   The scanner exports `analyzePackage(dir, patterns)`, which is the exact
//   function both of its legs call. This script drives that against the repo
//   and against the tarball `npm pack` would publish, reproducing the scan the
//   n8n reviewer will run — minus provenance, which cannot exist before the
//   publish. `.github/workflows/ci.yml` runs the published-artifact leg too.
//
// The scanner is stricter than `npm run lint` on the same files. It sets
// `allowInlineConfig: false`, so `// eslint-disable-next-line` comments in the
// node source do NOT apply, and it adds `no-console: error` on top of the
// n8n-nodes-base and community-nodes rulesets. Passing `npm run lint`
// therefore does not imply passing this.
//
// Usage:
//   node .github/scripts/scan-package.mjs <scanner-install-dir>
//
// Exits non-zero when either leg reports an error-level violation. Warnings do
// not fail the scan (that matches the scanner's own behaviour).

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const IS_WINDOWS = process.platform === 'win32';
const scannerDir = process.argv[2];

if (!scannerDir) {
	console.error('Usage: node .github/scripts/scan-package.mjs <scanner-install-dir>');
	process.exit(1);
}

const scannerEntry = join(
	resolve(scannerDir),
	'node_modules',
	'@n8n',
	'scan-community-package',
	'scanner',
	'scanner.mjs',
);

const { analyzePackage, SOURCE_FILE_PATTERNS } = await import(pathToFileURL(scannerEntry).href);

// The tarball leg needs the artifact `npm publish` would upload. `npm pack`
// builds exactly that from the `files` field. Scripts are skipped so packing
// cannot re-run a build or a release hook as a side effect — CI has already
// built `dist/` by the time this runs.
function run(command, args, cwd, useShell = false) {
	try {
		execFileSync(command, args, { cwd, stdio: 'pipe', shell: useShell });
	} catch (error) {
		const stderr = error.stderr?.toString().trim();
		throw new Error(`${command} ${args.join(' ')} failed${stderr ? `:\n${stderr}` : ''}`);
	}
}

function packedPackageDir() {
	const workDir = mkdtempSync(join(tmpdir(), 'n8n-scan-'));
	// npm is a .cmd shim on Windows, which Node refuses to spawn without a
	// shell. tar is a real binary and must NOT go through one — the shell
	// mangles the path separators.
	run('npm', ['pack', '--ignore-scripts', '--pack-destination', workDir], REPO_ROOT, IS_WINDOWS);

	const tarball = readdirSync(workDir).find((f) => f.endsWith('.tgz'));
	if (!tarball) throw new Error('npm pack produced no tarball');

	mkdirSync(join(workDir, 'package'), { recursive: true });
	run('tar', ['-xzf', tarball, '-C', 'package', '--strip-components=1'], workDir);
	return join(workDir, 'package');
}

// eslint's stylish formatter colours its output when it thinks a terminal is
// attached; the escapes are noise inside a markdown code fence.
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '[\\[][0-9;]*m', 'g');

function plain(text) {
	return text.replace(ANSI, '').trimEnd();
}

const legs = [
	{
		name: 'Source',
		what: '`package.json` and `{nodes,credentials}/**` in this commit',
		result: await analyzePackage(REPO_ROOT, SOURCE_FILE_PATTERNS),
	},
	{
		name: 'Packed artifact',
		what: 'the compiled `.js` and `package.json` inside the tarball `npm publish` would upload',
		result: await analyzePackage(packedPackageDir(), ['**/*.js', 'package.json']),
	},
];

const summary = ['## n8n community-package scan (this commit)', ''];
summary.push(
	'What `npx @n8n/scan-community-package` runs, pointed at this commit instead of a',
	'published version. Inline `eslint-disable` comments do not apply here.',
	'',
);

let failed = false;
for (const leg of legs) {
	const { passed, message, details } = leg.result;
	if (!passed) failed = true;
	summary.push(`### ${leg.name} — ${passed ? 'passed' : 'FAILED'}`, '', `Scanned ${leg.what}.`, '');
	if (message) summary.push(`${message}`, '');
	if (details) summary.push('```', plain(details), '```', '');
}

const report = summary.join('\n');
console.log(report);

// The whole point of this job is that a human sees this output, so it goes in
// the job summary too — not just the log, which nobody opens on a green run.
if (process.env.GITHUB_STEP_SUMMARY) {
	appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
}

process.exit(failed ? 1 : 0);
