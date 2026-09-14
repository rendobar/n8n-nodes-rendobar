// Code node body for "Sheet of quotes to quote videos". The n8n template embeds
// this function verbatim and the local test runner evaluates the same file, so the
// command n8n builds is the command that was rendered and checked.
// Input: one sheet row. Output: the Rendobar ffmpeg job's command and inputs.
function buildQuoteRender(row) {
  const DURATION = 10;
  const W = 1080;
  const H = 1920;
  const quote = String(row.quote ?? '').trim().replace(/\s+/g, ' ');
  const author = String(row.author ?? '').trim();
  const lang = String(row.language ?? 'en').trim() || 'en';
  if (!quote) throw new Error('This row has no quote text');
  for (const key of ['background_url', 'music_url', 'font_url']) {
    if (!/^https:\/\//.test(String(row[key] ?? ''))) throw new Error(`Column ${key} must be an https URL`);
  }

  // Wrap into balanced lines. Whole phrases (text between spaces) stay together
  // where they fit, so a Thai clause is never split from its connector. A phrase
  // too long for one line falls back to Intl.Segmenter word boundaries, which
  // work for Thai, Japanese and Chinese. Widths count graphemes, so Thai vowel
  // and tone marks do not count as extra characters.
  const graphemes = (s) => [...new Intl.Segmenter(lang, { granularity: 'grapheme' }).segment(s)].length;
  const maxPerLine = { th: 22, ja: 12, zh: 12, ko: 14, ar: 20, he: 20 }[lang.slice(0, 2)] ?? 22;
  const units = [];
  for (const phrase of quote.split(' ')) {
    if (graphemes(phrase) <= maxPerLine) {
      units.push({ text: phrase, space: true });
      continue;
    }
    let first = true;
    for (const { segment } of new Intl.Segmenter(lang, { granularity: 'word' }).segment(phrase)) {
      units.push({ text: segment, space: first });
      first = false;
    }
  }
  const lineCount = Math.ceil(graphemes(quote) / maxPerLine);
  const target = Math.min(maxPerLine, (graphemes(quote) / lineCount) * 1.15);
  const lines = [];
  let current = '';
  for (const unit of units) {
    const joined = current ? current + (unit.space ? ' ' : '') + unit.text : unit.text;
    const punctuationOnly = /^[\p{P}]+$/u.test(unit.text);
    if (current && !punctuationOnly && graphemes(joined) > target) {
      lines.push(current);
      current = unit.text;
    } else {
      current = joined;
    }
  }
  if (current) lines.push(current);

  // Size to the longest line: about half an em per Latin grapheme, a full em for CJK.
  const widthPerGrapheme = { ja: 1, zh: 1, ko: 0.95, th: 0.55, ar: 0.45, he: 0.5 }[lang.slice(0, 2)] ?? 0.5;
  const longest = Math.max(...lines.map(graphemes));
  const size = Math.max(48, Math.min(96, Math.floor(920 / (longest * widthPerGrapheme))));
  const lineHeight = Math.round(size * 1.4);
  const authorSize = Math.max(34, Math.round(size * 0.55));
  const blockHeight = lines.length * lineHeight + (author ? Math.round(authorSize * 2.2) : 0);
  const top = Math.round((H - blockHeight) / 2);

  // Text travels as files, never inside the filtergraph, so apostrophes, colons
  // and percent signs in a quote cannot break the command.
  const inputs = { background: row.background_url, music: row.music_url, 'font.ttf': row.font_url };
  const text = (file, fontSize, y, start, color) =>
    `drawtext=fontfile=font.ttf:textfile=${file}:expansion=none:fontsize=${fontSize}:fontcolor=${color}` +
    `:borderw=3:bordercolor=black@0.45:x=(w-text_w)/2:y=${y}:alpha='clip((t-${start.toFixed(2)})/0.7,0,1)'`;
  const texts = lines.map((line, i) => {
    inputs[`line${i + 1}.txt`] = { content: line };
    return text(`line${i + 1}.txt`, size, top + i * lineHeight, 0.6 + i * 0.45, 'white');
  });
  if (author) {
    inputs['author.txt'] = { content: author };
    const authorY = top + lines.length * lineHeight + Math.round(authorSize * 1.2);
    texts.push(text('author.txt', authorSize, authorY, 0.9 + lines.length * 0.45, 'white@0.85'));
  }

  // Slow push-in: the background grows 6% over the clip, re-evaluated per frame.
  const zoom = '(1+0.006*t)';
  const graph = [
    `[0:v]scale=w='trunc(${W}*${zoom}/2)*2':h='trunc(${H}*${zoom}/2)*2':force_original_aspect_ratio=increase:force_divisible_by=2:eval=frame,crop=${W}:${H},setsar=1,fps=30,eq=brightness=-0.05[bg]`,
    `color=c=black@0.3:s=${W}x${H}:r=30:d=${DURATION}[shade]`,
    `[bg][shade]overlay=shortest=1[base]`,
    `[base]${texts.join(',')},fade=t=out:st=${DURATION - 0.7}:d=0.7[v]`,
    `[1:a]atrim=0:${DURATION},asetpts=PTS-STARTPTS,afade=t=in:d=1,afade=t=out:st=${DURATION - 1.5}:d=1.5[a]`,
  ].join(';');

  const command =
    `-i background -i music -filter_complex "${graph}" -map "[v]" -map "[a]" -t ${DURATION} -r 30 ` +
    `-c:v libx264 -preset veryfast -crf 21 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart quote.mp4`;
  return { command, inputs, lines };
}
