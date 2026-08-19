// Get Many walks pages of GET /jobs. Two things there can go wrong quietly:
// losing track of the offset, which duplicates or skips rows, and handing the
// workflow more rows than Limit asked for.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
	currentRunIndex,
	pageExhausted,
	readLocator,
	roomFor,
} = require('../dist/nodes/Rendobar/Rendobar.node.js');

test('a page is trimmed to what Limit still has room for', () => {
	assert.equal(roomFor(50, 0, 50), 50);
	assert.equal(roomFor(50, 30, 50), 20);
	assert.equal(roomFor(50, 50, 50), 0);
	// A server that ignores or clamps the requested limit cannot over-deliver.
	assert.equal(roomFor(10, 0, 100), 10);
	// Already past the limit: nothing more is taken, and never a negative slice.
	assert.equal(roomFor(10, 20, 100), 0);
});

test('Return All takes whatever the page holds', () => {
	assert.equal(roomFor(Infinity, 0, 100), 100);
	assert.equal(roomFor(Infinity, 5000, 100), 100);
});

test('the end of the list is judged on the rows the API sent', () => {
	// A full page is never the end.
	assert.equal(pageExhausted(100, 100, 100, undefined), false);
	// A short page is.
	assert.equal(pageExhausted(40, 100, 40, undefined), true);
	// So is reaching the reported total.
	assert.equal(pageExhausted(100, 100, 100, 100), true);
	assert.equal(pageExhausted(100, 100, 100, 250), false);
});

test('a row that is not an object still counts toward the offset', () => {
	// This is the drift: `data: [job, null, job]` narrows to two usable rows. If
	// paging counted two, the next request would start one row early — reading a
	// row twice — and a Return All would stop here, because two is short of the
	// page size.
	const rows = [{ id: 'a' }, null, { id: 'b' }];
	const usable = rows.filter((row) => typeof row === 'object' && row !== null);

	assert.equal(usable.length, 2);
	assert.equal(pageExhausted(rows.length, 3, rows.length, undefined), false);
	// Counting only the usable rows would have called it the end of the list.
	assert.equal(pageExhausted(usable.length, 3, usable.length, undefined), true);
});

test('the run index survives a context that has no getExecuteData', () => {
	// The AI-tool context is n8n's supply-data shape, whose type does not
	// include getExecuteData. Calling it blind throws a TypeError, which `?.` on
	// the result cannot catch.
	assert.equal(currentRunIndex({}), 0);
	assert.equal(currentRunIndex({ getNextRunIndex: () => 7 }), 0, 'must not be trusted for the key');
});

test('the run index is read from a normal execution context', () => {
	assert.equal(currentRunIndex({ getExecuteData: () => ({ runIndex: 3 }) }), 3);
	assert.equal(currentRunIndex({ getExecuteData: () => undefined }), 0);
	assert.equal(currentRunIndex({ getExecuteData: () => ({}) }), 0);
});

test('a throwing getExecuteData degrades instead of stopping the item', () => {
	assert.equal(
		currentRunIndex({
			getExecuteData() {
				throw new TypeError('not available here');
			},
		}),
		0,
	);
});

test('a locator is only asked to extract when there is a locator', () => {
	const calls = [];
	const context = {
		getNodeParameter(name, itemIndex, fallback, options) {
			calls.push(options?.extractValue === true ? 'extract' : 'raw');
			return options?.extractValue === true
				? 'job_extracted'
				: { __rl: true, mode: 'url', value: 'https://app.rendobar.com/jobs/job_extracted' };
		},
	};

	assert.equal(readLocator(context, 'jobId', 0), 'job_extracted');
	assert.deepEqual(calls, ['raw', 'extract']);
});

test('a workflow saved before the parameter was a locator still reads', () => {
	// The stored value is a bare string. Asking n8n to extract from it buys
	// nothing and is the call most likely to raise, so it is skipped.
	const calls = [];
	const context = {
		getNodeParameter(name, itemIndex, fallback, options) {
			calls.push(options?.extractValue === true ? 'extract' : 'raw');
			return '={{ $json.id }}';
		},
	};

	assert.equal(readLocator(context, 'jobId', 0), '={{ $json.id }}');
	assert.deepEqual(calls, ['raw'], 'extraction must not be attempted on a plain string');
});
