// Code node body that attaches the font file to the quote render. It runs after the
// Google Fonts lookups, which were tried bold first because not every family has a bold.
// Each response is the CSS text of one lookup, or an error page when that weight does not exist.
function pickQuoteFontFile(font, responses) {
  if (font.fileUrl) return font.fileUrl;
  for (const css of responses) {
    const match = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/.exec(String(css ?? ''));
    if (match) return match[1];
  }
  throw new Error(`Google Fonts has no family named "${font.family}". Check the spelling in the font column, or put your own font file in font_url.`);
}
