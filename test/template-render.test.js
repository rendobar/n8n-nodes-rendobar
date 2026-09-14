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
const { chooseQuoteFont, buildQuoteRender } = load('quote-render.js', ['chooseQuoteFont', 'buildQuoteRender']);
const { pickQuoteFontFile } = load('quote-font-file.js', ['pickQuoteFontFile']);
const { groupWords, buildShortRender } = load('shorts-render.js', ['groupWords', 'buildShortRender']);
const { buildListingRender } = load('listing-render.js', ['buildListingRender']);
const { checkUpload } = load('upload-qc.js', ['checkUpload']);

const media = { background_url: 'https://x.test/b.mp4', music_url: 'https://x.test/m.mp3' };
const quoteRender = (row) => buildQuoteRender(row, chooseQuoteFont(row));

test('Thai quotes wrap on phrases, not in the middle of a clause', () => {
	const r = quoteRender({ ...media, language: 'th', quote: 'อย่านับวันที่ผ่านไป จงทำให้ทุกวันมีความหมาย' });
	assert.deepEqual(r.lines, ['อย่านับวันที่ผ่านไป', 'จงทำให้ทุกวันมีความหมาย']);
});

test('short quotes balance their lines instead of leaving one word behind', () => {
	assert.deepEqual(quoteRender({ ...media, language: 'ar', quote: 'من جد وجد، ومن زرع حصد' }).lines, ['من جد وجد،', 'ومن زرع حصد']);
	assert.deepEqual(quoteRender({ ...media, language: 'en', quote: "Don't count the days. Make the days count." }).lines, [
		"Don't count the days.",
		'Make the days count.',
	]);
});

test('right-to-left lines carry direction marks so a trailing comma stays on the left', () => {
	const ass = quoteRender({ ...media, language: 'ar', quote: 'من جد وجد، ومن زرع حصد', author: 'مثل عربي' }).inputs['quote.ass'].content;
	assert.ok(ass.includes('}‏من جد وجد،‏\n'), 'line 1 is wrapped in right-to-left marks');
	assert.ok(ass.includes('}‏مثل عربي‏\n'), 'the author is wrapped too');
	const english = quoteRender({ ...media, language: 'en', quote: 'Make the days count.' }).inputs['quote.ass'].content;
	assert.ok(english.includes('}Make the days count.\n') && !english.includes('‏'), 'left-to-right text carries no marks');
});

test('quote text travels in a subtitle file shaped by libass, never inside the FFmpeg command', () => {
	const r = quoteRender({ ...media, language: 'en', quote: "It's 100% {true}: don't quote me.", author: "O'Brien" });
	assert.ok(!r.command.includes("It's") && !r.command.includes("O'Brien"), 'text leaked into the command');
	assert.match(r.command, /ass=quote\.ass:fontsdir=fonts:shaping=complex/);
	assert.ok(r.inputs['quote.ass'].content.includes('100% \\{true\\}:'), 'braces are escaped so they cannot open an override block');
	assert.ok(r.inputs['quote.ass'].content.includes('Style: Quote,Montserrat,'), 'the style names the font inside the file');
});

test('every language gets its own default font, and regional tags resolve', () => {
	const family = (language) => chooseQuoteFont({ language }).family;
	assert.equal(family('ar'), 'Cairo');
	assert.equal(family('th'), 'Kanit');
	assert.equal(family('pt-BR'), 'Montserrat');
	assert.equal(family('uk'), 'Montserrat');
	assert.equal(family('mr'), 'Noto Sans Devanagari');
	assert.equal(family('zh'), 'Noto Sans SC');
	assert.equal(family('zh-TW'), 'Noto Sans TC');
	assert.equal(family('zh_Hant'), 'Noto Sans TC');
	assert.equal(family('xx'), 'Montserrat', 'an unknown language falls back to the Latin default');
	assert.equal(family(''), 'Montserrat');
});

test('the font column takes any Google Fonts family, looked up bold first', () => {
	const font = chooseQuoteFont({ language: 'ar', font: 'IBM Plex Sans Arabic' });
	assert.equal(font.name, 'IBM Plex Sans Arabic');
	assert.equal(font.fileUrl, null);
	assert.deepEqual(font.lookups, [
		'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@700',
		'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400',
		'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic',
	]);
	assert.equal(font.widthPerGrapheme, chooseQuoteFont({ language: 'ar' }).widthPerGrapheme, 'a custom font is sized like its language default');
});

test('your own font file needs the family name inside it', () => {
	assert.throws(() => chooseQuoteFont({ language: 'ar', font_url: 'https://x.test/f.ttf' }), /font_family/);
	assert.throws(() => chooseQuoteFont({ language: 'ar', font_url: 'http://x.test/f.ttf', font_family: 'Mine' }), /https/);
	const font = chooseQuoteFont({ language: 'ar', font_url: 'https://x.test/f.ttf', font_family: 'My Brand Arabic' });
	const r = buildQuoteRender({ ...media, language: 'ar', quote: 'من جد وجد' }, font);
	assert.equal(r.inputs['fonts/font.ttf'], 'https://x.test/f.ttf');
	assert.ok(r.inputs['quote.ass'].content.includes('Style: Quote,My Brand Arabic,'));
	assert.equal(pickQuoteFontFile(font, []), 'https://x.test/f.ttf', 'no lookup is needed');
});

test('the font file comes from the first lookup that found a weight', () => {
	const font = chooseQuoteFont({ language: 'he', font: 'Secular One' });
	const regular = "@font-face { font-family: 'Secular One'; src: url(https://fonts.gstatic.com/s/secularone/v14/abc.ttf) format('truetype'); }";
	assert.equal(pickQuoteFontFile(font, ['<!DOCTYPE html><title>Error 400</title>', regular, regular]), 'https://fonts.gstatic.com/s/secularone/v14/abc.ttf');
	assert.throws(() => pickQuoteFontFile(chooseQuoteFont({ font: 'Not A Real Font' }), ['400', '400', '400']), /Not A Real Font/);
});

test('wide scripts are sized to fit the frame', () => {
	for (const [language, quote] of [['ta', 'முயற்சி திருவினையாக்கும். கற்றது கைமண் அளவு, கல்லாதது உலகளவு.'], ['ml', 'അറിവാണ് ശക്തി. ക്ഷമയാണ് ഏറ്റവും വലിയ ധനം.']]) {
		const font = chooseQuoteFont({ language });
		const r = buildQuoteRender({ ...media, language, quote }, font);
		const size = Number(r.inputs['quote.ass'].content.match(/^Style: Quote,[^,]+,(\d+),/m)[1]) / 1.2;
		const widest = Math.max(...r.lines.map((l) => [...new Intl.Segmenter(language, { granularity: 'grapheme' }).segment(l)].length));
		assert.ok(widest * font.widthPerGrapheme * size <= 1000, `${language} line of ${widest} graphemes at ${size}px overflows`);
	}
});

test('a quote row with a missing media column names the column', () => {
	assert.throws(() => quoteRender({ quote: 'x', music_url: media.music_url }), /background_url/);
	assert.throws(() => quoteRender({ ...media, quote: '' }), /no quote text/);
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
