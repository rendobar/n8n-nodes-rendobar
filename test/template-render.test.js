// The FFmpeg templates' Code nodes embed the modules in templates/src/render verbatim,
// so their logic is tested here like any other code, and the committed workflow JSON
// must match what templates/src/build.mjs generates from them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');

const root = join(__dirname, '..');
const src = join(root, 'templates', 'src');
const load = (file, names) =>
	new Function(`${readFileSync(join(src, 'render', file), 'utf8')}\nreturn { ${names.join(', ')} };`)();
const { buildQuoteRender } = load('quote-render.js', ['buildQuoteRender']);
const { groupWords, buildShortRender } = load('shorts-render.js', ['groupWords', 'buildShortRender']);
const { buildListingRender } = load('listing-render.js', ['buildListingRender']);
const { checkUpload } = load('upload-qc.js', ['checkUpload']);

const media = { background_url: 'https://x.test/b.mp4', music_url: 'https://x.test/m.mp3', font_url: 'https://x.test/f.ttf' };

test('Thai quotes wrap on phrases, not in the middle of a clause', () => {
	const r = buildQuoteRender({ ...media, language: 'th', quote: 'อย่านับวันที่ผ่านไป จงทำให้ทุกวันมีความหมาย' });
	assert.deepEqual(r.lines, ['อย่านับวันที่ผ่านไป', 'จงทำให้ทุกวันมีความหมาย']);
});

test('short quotes balance their lines instead of leaving one word behind', () => {
	assert.deepEqual(buildQuoteRender({ ...media, language: 'ar', quote: 'من جد وجد، ومن زرع حصد' }).lines, ['من جد وجد،', 'ومن زرع حصد']);
	assert.deepEqual(buildQuoteRender({ ...media, language: 'en', quote: "Don't count the days. Make the days count." }).lines, [
		"Don't count the days.",
		'Make the days count.',
	]);
});

test('quote text travels as files and never inside the FFmpeg command', () => {
	const r = buildQuoteRender({ ...media, language: 'en', quote: "It's 100% true: don't quote me.", author: "O'Brien" });
	assert.ok(!r.command.includes("It's") && !r.command.includes("O'Brien"), 'text leaked into the command');
	assert.match(r.command, /textfile=line1\.txt:expansion=none/);
	assert.deepEqual(r.inputs['author.txt'], { content: "O'Brien" });
});

test('a quote row with a missing media column names the column', () => {
	assert.throws(() => buildQuoteRender({ quote: 'x', music_url: media.music_url, font_url: media.font_url }), /background_url/);
});

test('captions break at sentence ends and each one lands in exactly one clip', () => {
	const captions = groupWords([
		{ word: 'This', start: 0, end: 0.4 },
		{ word: 'is', start: 0.4, end: 0.6 },
		{ word: 'done.', start: 0.6, end: 1 },
		{ word: 'Next', start: 9.8, end: 10.3 },
		{ word: 'part', start: 10.3, end: 10.7 },
	]);
	assert.deepEqual(captions.map((c) => c.text), ['This is done.', 'Next part']);
	const options = { sourceUrl: 'https://x.test/s.mp4', fontUrl: 'https://x.test/a.ttf' };
	const first = buildShortRender({ start: 0, end: 10, hook: 'Iran could be suspended from chess' }, captions, options);
	const second = buildShortRender({ start: 10, end: 20, hook: 'Second clip' }, captions, options);
	assert.ok(!first.inputs['captions.srt'].content.includes('NEXT PART'), 'a boundary caption was burned into both clips');
	assert.ok(second.inputs['captions.srt'].content.includes('NEXT PART'));
	assert.deepEqual([first.inputs['hook1.txt'].content, first.inputs['hook2.txt'].content], ['IRAN COULD BE', 'SUSPENDED FROM CHESS']);
});

test('a five-photo tour runs 15.9 seconds and a tour needs 3 to 12 photos', () => {
	const listing = {
		photos: [1, 2, 3, 4, 5].map((n) => `https://x.test/${n}.jpg`),
		music_url: 'https://x.test/m.mp3',
		display_font_url: 'https://x.test/d.ttf',
		body_font_url: 'https://x.test/b.ttf',
		price: '$1,250,000',
		address: "12 O'Neil Court",
		beds: 4,
		baths: 3,
		sqft: 2650,
		agent_name: 'Jordan Lee',
		agent_phone: '(555) 010-0142',
		brokerage: 'Example Realty',
	};
	const r = buildListingRender(listing);
	assert.equal(r.seconds, 15.9);
	assert.deepEqual(r.inputs['specs.txt'], { content: '4 bd · 3 ba · 2,650 sq ft' });
	assert.throws(() => buildListingRender({ ...listing, photos: listing.photos.slice(0, 2) }), /3 to 12 photos/);
});

test('upload QC fails a 534 px film on resolution and passes a 1080p file', () => {
	const probe = (width, height) => ({
		summary: { durationSec: 90, streamCounts: { audio: 1 }, audio: { codec: 'aac' }, video: { codec: 'h264', width, height, isHdr: false } },
		streams: [{ codec_type: 'video', avg_frame_rate: '24/1' }],
	});
	assert.deepEqual(checkUpload(probe(1280, 534)).failed, ['Resolution']);
	assert.equal(checkUpload(probe(1920, 1080)).passed, true);
	assert.equal(checkUpload(probe(1080, 1920)).passed, true, 'a vertical 1080p upload counts as 1080p');
});

test('the committed templates match what the generator builds', () => {
	const out = mkdtempSync(join(tmpdir(), 'rendobar-templates-'));
	execFileSync(process.execPath, [join(src, 'build.mjs'), out]);
	const lf = (s) => s.replace(/\r\n/g, '\n');
	for (const file of readdirSync(out)) {
		assert.equal(
			lf(readFileSync(join(root, 'templates', file), 'utf8')),
			lf(readFileSync(join(out, file), 'utf8')),
			`templates/${file} is stale: run node templates/src/build.mjs`,
		);
	}
});
