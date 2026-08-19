// The Job list behind the 'Job' Resource Locator. `GET /jobs` has no free-text
// search, so the filter the user types is matched against the page in hand.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
	jobSearchLabel,
	matchesJobSearch,
} = require('../dist/nodes/Rendobar/listSearch/getJobs.js');

const job = {
	id: 'job_abc123',
	type: 'ffmpeg',
	status: 'complete',
	createdAt: Date.parse('2026-08-19T09:30:00Z'),
	webUrl: 'https://app.rendobar.com/jobs/job_abc123',
};

test('a list entry says what the job was and how it ended', () => {
	const label = jobSearchLabel(job);
	assert.ok(label.includes('ffmpeg'));
	assert.ok(label.includes('complete'));
	assert.ok(label.includes('job_abc123'));
	assert.ok(label.includes('2026-08-19'));
});

test('a job with only an ID still produces a usable entry', () => {
	assert.equal(jobSearchLabel({ id: 'job_x' }), 'job_x');
	assert.equal(jobSearchLabel({ type: 'ffmpeg' }), undefined, 'no ID means nothing to select');
});

test('the typed filter matches the ID, the type or the status', () => {
	assert.equal(matchesJobSearch(job, 'ffmpeg'), true);
	assert.equal(matchesJobSearch(job, 'abc123'), true);
	assert.equal(matchesJobSearch(job, 'complete'), true);
	assert.equal(matchesJobSearch(job, 'watermark'), false);
});

test('the filter ignores fields the job does not have', () => {
	assert.equal(matchesJobSearch({ id: 'job_x' }, 'job_x'), true);
	assert.equal(matchesJobSearch({}, 'anything'), false);
});
