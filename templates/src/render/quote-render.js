// Code node bodies for "Sheet of quotes to quote videos". The n8n template embeds
// this file verbatim and the local test runner evaluates the same file, so the
// command n8n builds is the command that was rendered and checked.

// The default font for each language: the Google Fonts family, the family name
// inside its bold file (libass matches that name, and a few files differ from the
// Google name), and how many ems one grapheme takes on screen. The widths were
// measured from real renders of each font, so text is sized to the font instead
// of guessed per language. Every entry passed the same checks: it covers its
// script plus Latin letters and digits, has a true bold, and libass selected the
// file itself rather than falling back to another font.
const QUOTE_FONTS = {
  latin: ['Montserrat', 'Montserrat', 0.41],
  vi: ['Be Vietnam Pro', 'Be Vietnam Pro', 0.41],
  cyrillic: ['Montserrat', 'Montserrat', 0.49],
  el: ['Commissioner', 'Commissioner', 0.36],
  ar: ['Cairo', 'Cairo', 0.32],
  fa: ['Vazirmatn', 'Vazirmatn', 0.32],
  ur: ['Noto Nastaliq Urdu', 'Noto Nastaliq Urdu', 0.19],
  he: ['Heebo', 'Heebo', 0.36],
  hi: ['Noto Sans Devanagari', 'Noto Sans Devanagari', 0.35],
  bn: ['Hind Siliguri', 'Hind Siliguri', 0.46],
  ta: ['Noto Sans Tamil', 'Noto Sans Tamil', 1.2],
  te: ['Noto Sans Telugu', 'Noto Sans Telugu', 0.75],
  kn: ['Noto Sans Kannada', 'Noto Sans Kannada', 0.48],
  ml: ['Manjari', 'Manjari', 0.73],
  gu: ['Noto Sans Gujarati', 'Noto Sans Gujarati', 0.46],
  pa: ['Noto Sans Gurmukhi', 'Noto Sans Gurmukhi', 0.54],
  si: ['Abhaya Libre', 'Abhaya Libre', 0.55],
  th: ['Kanit', 'Kanit', 0.45],
  lo: ['Noto Sans Lao Looped', 'Noto Sans Lao Looped', 0.38],
  km: ['Kantumruy Pro', 'Kantumruy Pro', 0.71],
  my: ['Noto Sans Myanmar', 'Noto Sans Myanmar', 0.41],
  am: ['Menbere', 'Menbere', 0.49],
  ka: ['Noto Sans Georgian', 'Noto Sans Georgian', 0.55],
  hy: ['Noto Sans Armenian', 'Noto Sans Armenian', 0.48],
  'zh-Hans': ['Noto Sans SC', 'Noto Sans SC', 0.77],
  'zh-Hant': ['Noto Sans TC', 'Noto Sans TC', 0.79],
  ja: ['Noto Sans JP', 'Noto Sans JP', 0.82],
  ko: ['Noto Sans KR', 'Noto Sans KR', 0.57],
};
// Languages that share a default with another code. Anything not listed and not a
// key above uses the Latin default, so a language in another script needs the font column.
const QUOTE_FONT_ALIASES = { mr: 'hi', ne: 'hi', ti: 'am', ru: 'cyrillic', uk: 'cyrillic', be: 'cyrillic', bg: 'cyrillic', mk: 'cyrillic', kk: 'cyrillic', ky: 'cyrillic', mn: 'cyrillic' };

// Pick the font for a row. The font column takes any Google Fonts family; font_url
// takes your own font file instead, with font_family naming the font inside it.
// Returns the Google Fonts lookups to try, bold first, since not every family has a bold.
function chooseQuoteFont(row) {
  const tag = String(row.language ?? 'en').trim().toLowerCase() || 'en';
  const [base, region = ''] = tag.split(/[-_]/);
  const key = base === 'zh' ? (/^(tw|hk|mo|hant)$/.test(region) ? 'zh-Hant' : 'zh-Hans') : (QUOTE_FONT_ALIASES[base] ?? base);
  const [defaultFamily, defaultName, widthPerGrapheme] = QUOTE_FONTS[key] ?? QUOTE_FONTS.latin;
  const custom = String(row.font ?? '').trim();
  const ownFile = String(row.font_url ?? '').trim();
  const nameInFile = String(row.font_family ?? '').trim();
  if (ownFile && !/^https:\/\//.test(ownFile)) throw new Error('Column font_url must be an https URL');
  if (ownFile && !nameInFile) throw new Error('Column font_family must name the font in font_url, for example Cairo');
  const family = custom || defaultFamily;
  const lookup = (weight) => `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}${weight ? `:wght@${weight}` : ''}`;
  return {
    family,
    name: nameInFile || (custom ? custom : defaultName),
    widthPerGrapheme,
    fileUrl: ownFile || null,
    lookups: [lookup(700), lookup(400), lookup(null)],
  };
}

// Input: one sheet row and its chosen font. Output: the Rendobar ffmpeg job's command and inputs.
// The font file input stays empty until the Google Fonts lookup fills it (quote-font-file.js).
function buildQuoteRender(row, font) {
  const DURATION = 10;
  const W = 1080;
  const H = 1920;
  const quote = String(row.quote ?? '').trim().replace(/\s+/g, ' ');
  const author = String(row.author ?? '').trim();
  const lang = String(row.language ?? 'en').trim() || 'en';
  const base = lang.slice(0, 2).toLowerCase();
  if (!quote) throw new Error('This row has no quote text');
  for (const key of ['background_url', 'music_url']) {
    if (!/^https:\/\//.test(String(row[key] ?? ''))) throw new Error(`Column ${key} must be an https URL`);
  }

  // Wrap into balanced lines. Whole phrases (text between spaces) stay together
  // where they fit, so a Thai clause is never split from its connector. A phrase
  // too long for one line falls back to Intl.Segmenter word boundaries, which
  // work for Thai, Japanese and Chinese. Widths count graphemes, so Thai vowel
  // and tone marks do not count as extra characters. Wide scripts get fewer
  // graphemes per line, so a Tamil or Malayalam line never runs off the frame.
  const graphemes = (s) => [...new Intl.Segmenter(lang, { granularity: 'grapheme' }).segment(s)].length;
  const wpg = font.widthPerGrapheme;
  const preferred = { th: 22, ja: 12, zh: 12, ko: 14, ar: 20, he: 20 }[base] ?? 22;
  const maxPerLine = Math.max(6, Math.min(preferred, Math.floor(920 / (wpg * 60))));
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

  // Size the longest line to about 920 px, using the font's measured width per grapheme.
  const longest = Math.max(...lines.map(graphemes));
  const size = Math.max(40, Math.min(96, Math.floor(920 / (longest * wpg))));
  // Nastaliq stacks letters diagonally and needs more room between lines.
  const lineHeight = Math.round(size * (base === 'ur' ? 1.9 : 1.45));
  const authorSize = Math.max(34, Math.round(size * 0.55));
  const blockHeight = lines.length * lineHeight + (author ? Math.round(authorSize * 2) : 0);
  const top = Math.round((H - blockHeight) / 2);

  // The text is drawn by libass from a subtitle file, with harfbuzz shaping. FFmpeg's
  // drawtext swaps Arabic letters for legacy presentation forms that modern fonts such
  // as Cairo leave out, and draws empty boxes for them. libass still lays a line out
  // left to right unless the text says otherwise, so right-to-left lines carry a
  // right-to-left mark at each end to keep trailing punctuation on the correct side.
  const rtl = ['ar', 'fa', 'he', 'ur', 'ps', 'yi'].includes(base);
  const directed = (s) => (rtl ? `‏${s}‏` : s);
  // In a subtitle file braces open override blocks and a backslash starts a tag.
  const escape = (s) => s.replace(/\\/g, '⧵').replace(/[{}]/g, (c) => `\\${c}`);
  const stamp = (s) => {
    const cs = Math.round(s * 100);
    const pad = (v) => String(v).padStart(2, '0');
    return `${Math.floor(cs / 360000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
  };
  const style = (name, px, alpha, outline) =>
    `Style: ${name},${font.name},${px},&H${alpha}FFFFFF,&H${alpha}FFFFFF,&H73000000,&H00000000,0,0,0,0,100,100,0,0,1,${outline},0,5,60,60,0,1`;
  const event = (styleName, start, y, text) =>
    `Dialogue: 0,${stamp(start)},${stamp(DURATION)},${styleName},,0,0,0,,{\\pos(${W / 2},${y})\\fad(700,0)}${directed(escape(text))}`;
  const events = lines.map((line, i) => event('Quote', 0.6 + i * 0.45, top + i * lineHeight + Math.round(lineHeight / 2), line));
  if (author) {
    events.push(event('Author', 0.9 + lines.length * 0.45, top + lines.length * lineHeight + Math.round(authorSize * 1.1), author));
  }
  const subtitles = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    style('Quote', Math.round(size * 1.2), '00', 3),
    style('Author', Math.round(authorSize * 1.2), '26', 2),
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
  ].join('\n') + '\n';

  // The font sits in its own folder, so libass never tries to read the background video as a font.
  const inputs = { background: row.background_url, music: row.music_url, 'fonts/font.ttf': font.fileUrl, 'quote.ass': { content: subtitles } };

  // Slow push-in: the background grows 6% over the clip, re-evaluated per frame.
  const zoom = '(1+0.006*t)';
  const graph = [
    `[0:v]scale=w='trunc(${W}*${zoom}/2)*2':h='trunc(${H}*${zoom}/2)*2':force_original_aspect_ratio=increase:force_divisible_by=2:eval=frame,crop=${W}:${H},setsar=1,fps=30,eq=brightness=-0.05[bg]`,
    `color=c=black@0.3:s=${W}x${H}:r=30:d=${DURATION}[shade]`,
    `[bg][shade]overlay=shortest=1,ass=quote.ass:fontsdir=fonts:shaping=complex,fade=t=out:st=${DURATION - 0.7}:d=0.7[v]`,
    `[1:a]atrim=0:${DURATION},asetpts=PTS-STARTPTS,afade=t=in:d=1,afade=t=out:st=${DURATION - 1.5}:d=1.5[a]`,
  ].join(';');

  const command =
    `-i background -i music -filter_complex "${graph}" -map "[v]" -map "[a]" -t ${DURATION} -r 30 ` +
    `-c:v libx264 -preset veryfast -crf 21 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart quote.mp4`;
  return { command, inputs, lines };
}
