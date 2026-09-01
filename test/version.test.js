const assert = require('node:assert/strict');
const { test } = require('node:test');
const pkg = require('../package.json');
const { NODE_VERSION } = require('../dist/nodes/Rendobar/shared/version.js');

/**
 * The version half of `X-Rendobar-Client` is hardcoded, because the credentials
 * file is a declarative object n8n serialises and a JSON import there would
 * change how the node is packaged for one string. This is what stops it going
 * stale: without it, the constant silently reports an old build forever.
 */
test('the reported version matches the package version', () => {
  assert.equal(
    NODE_VERSION,
    pkg.version,
    `NODE_VERSION is ${NODE_VERSION} but package.json is ${pkg.version}. Bump both.`,
  );
});

test('the client tag is the product form Rendobar parses', () => {
  const tag = `n8n/${NODE_VERSION}`;
  assert.equal(tag.split('/')[0], 'n8n');
  assert.match(tag, /^n8n\/\d+\.\d+\.\d+/);
});
