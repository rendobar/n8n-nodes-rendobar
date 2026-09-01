/**
 * Reported to Rendobar on every request as the version half of
 * `X-Rendobar-Client`, so a bug report can name the build it came from.
 *
 * Hardcoded rather than imported from package.json: the credentials file is a
 * declarative object n8n serialises, and pulling a JSON import into it would
 * change how the node is packaged for one string. `test/version.test.js` fails
 * if this and the package version ever disagree, which is the part that keeps
 * it honest.
 */
export const NODE_VERSION = '0.5.0';
