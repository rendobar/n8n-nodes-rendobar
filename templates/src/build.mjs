// Generate the four FFmpeg n8n templates. Every Code node embeds a render module
// from ./render verbatim, the same file the local job runner evaluated, so the
// FFmpeg command a user's n8n builds is the one that was rendered and checked.
// Usage: node templates/src/build.mjs [outDir]   (default: the templates folder)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ?? join(HERE, "..");
mkdirSync(OUT, { recursive: true });
const moduleSource = (file) => readFileSync(join(HERE, "render", file), "utf8").trim();
const moduleExports = (file, names) => new Function(`${moduleSource(file)}\nreturn { ${names.join(", ")} };`)();

// Stable ids: regenerating a template does not churn every node id.
const uuid = (seed) => {
  const h = createHash("sha1").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const RENDOBAR = "@rendobar/n8n-nodes-rendobar.rendobar";
const RESUME = "={{ $execution.resumeUrl }}";
const row = (x, y = 40) => [x, y];

function build(slug, name, nodes, edges) {
  const connections = {};
  for (const [from, to, output = 0] of edges) {
    connections[from] ??= { main: [] };
    while (connections[from].main.length <= output) connections[from].main.push([]);
    connections[from].main[output].push({ node: to, type: "main", index: 0 });
  }
  return {
    name,
    nodes: nodes.map((n) => ({ id: uuid(`${slug}:${n.name}`), ...n, ...(n.webhook ? { webhookId: uuid(`${slug}:${n.name}:webhook`) } : {}), webhook: undefined })),
    connections,
    settings: { executionOrder: "v1" },
  };
}

const sticky = (name, content, position, width, height, color) => ({
  name, type: "n8n-nodes-base.stickyNote", typeVersion: 1, position,
  parameters: { content, height, width, ...(color ? { color } : {}) },
});
const createJob = (name, position, jobType, inputs, command) => ({
  name, type: RENDOBAR, typeVersion: 1, position,
  parameters: {
    resource: "job", operation: "create",
    jobType: { __rl: true, mode: "id", value: jobType },
    inputsMode: "json", inputs,
    paramsMode: "fields", params: { mappingMode: "defineBelow", value: { command } },
    options: { callbackUrl: RESUME }, output: "simplified",
  },
});
const waitFor = (name, position) => ({
  name, type: "n8n-nodes-base.wait", typeVersion: 1.1, position, webhook: true,
  parameters: { resume: "webhook", httpMethod: "POST", limitWaitTime: true, limitType: "afterTimeInterval", resumeAmount: 10, resumeUnit: "hours", options: {} },
});
const getJob = (name, position, download) => ({
  name, type: RENDOBAR, typeVersion: 1, position,
  parameters: {
    resource: "job", operation: "get",
    jobId: { __rl: true, mode: "id", value: "={{ $json.body.data.jobId }}" },
    ...(download ? { downloadOutput: true, outputBinaryProperty: "data" } : {}),
    output: "simplified",
  },
});
const uploadFile = (name, position) => ({ name, type: RENDOBAR, typeVersion: 1, position, parameters: { resource: "file", operation: "upload", binaryProperty: "data" } });
const codeNode = (name, position, jsCode, mode = "runOnceForEachItem") => ({ name, type: "n8n-nodes-base.code", typeVersion: 2, position, parameters: { mode, jsCode } });
const loopNode = (name, position) => ({ name, type: "n8n-nodes-base.splitInBatches", typeVersion: 3, position, parameters: { options: {} } });
const driveTrigger = (name, position) => ({
  name, type: "n8n-nodes-base.googleDriveTrigger", typeVersion: 1, position,
  parameters: { pollTimes: { item: [{ mode: "everyMinute" }] }, triggerOn: "specificFolder", folderToWatch: { __rl: true, mode: "list", value: "" }, event: "fileCreated", options: {} },
});
const driveDownload = (name, position) => ({
  name, type: "n8n-nodes-base.googleDrive", typeVersion: 3, position,
  parameters: { operation: "download", fileId: { __rl: true, mode: "id", value: "={{ $json.id }}" }, options: {} },
});
const slackPost = (name, position, text) => ({
  name, type: "n8n-nodes-base.slack", typeVersion: 2.7, position,
  parameters: { select: "channel", channelId: { __rl: true, mode: "list", value: "" }, text, otherOptions: {} },
});
const slackUpload = (name, position, initialComment) => ({
  name, type: "n8n-nodes-base.slack", typeVersion: 2.7, position,
  parameters: { resource: "file", operation: "upload", binaryPropertyName: "data", options: { channelId: "", initialComment } },
});
const youtubeUpload = (name, position, title, description) => ({
  name, type: "n8n-nodes-base.youTube", typeVersion: 1, position,
  parameters: { resource: "video", operation: "upload", title, regionCode: "US", categoryId: "22", binaryProperty: "data", options: { privacyStatus: "private", description } },
});
const withModule = (file, lines) => `${moduleSource(file)}\n\n${lines.join("\n")}`;
const SETUP_KEY = "1. Create a Rendobar account at rendobar.com, make an API key under Settings, and add it as a Rendobar API credential on every Rendobar node.";

// ---------------------------------------------------------------------------
// 1. Sheet of quotes to quote videos
// ---------------------------------------------------------------------------
{
  const code = withModule("quote-render.js", [
    "const render = buildQuoteRender($json);",
    "return { json: { ...$json, render_command: render.command, render_inputs: render.inputs } };",
  ]);
  const main = [
    "## How it works",
    "",
    "Add a row to a Google Sheet with a quote, its author, a language code and links to a background clip, a music track and a font. Each new row becomes a 10 second vertical quote video on YouTube.",
    "",
    "A Code node wraps the quote into balanced lines with Intl.Segmenter, so Thai, Japanese and Chinese break on real word boundaries and Arabic stays right to left. Every line travels to Rendobar as its own text file, so apostrophes, colons and percent signs in a quote never break the FFmpeg command. Rendobar renders a slow push-in on the background, lines that fade in one after another, and a music bed.",
    "",
    "The job carries the Wait node's resume URL as its callback, so the execution parks for free while FFmpeg works. When the video is ready the workflow downloads it, uploads it to YouTube as private and marks the row done. Rows run one at a time.",
    "",
    "## Setup steps",
    "",
    SETUP_KEY,
    "2. Make a sheet with the columns quote, author, language, background_url, music_url, font_url, status and video_id.",
    "3. Connect Google Sheets in both Sheets nodes and YouTube in the upload node.",
    "4. Use a background clip of at least 10 seconds, so nothing loops, and a font that covers your language, such as a Noto font.",
  ].join("\n");
  const wf = build("quotes", "Turn a sheet of quotes into vertical quote videos in any language with Rendobar", [
    sticky("How it works", main, [-80, -780], 700, 700),
    sticky("Section: render", "### Wrap and render\nThe Code node splits the quote into lines and builds the FFmpeg command. Rendobar renders while the Wait node parks the execution.", [400, -60], 660, 260, 7),
    sticky("Section: publish", "### Publish\nGet downloads the video, YouTube receives it as private, and the row is marked done so it never renders twice.", [1080, -60], 660, 260, 7),
    {
      name: "Watch for new quotes", type: "n8n-nodes-base.googleSheetsTrigger", typeVersion: 1, position: row(0),
      parameters: { pollTimes: { item: [{ mode: "everyMinute" }] }, documentId: { __rl: true, mode: "list", value: "" }, sheetName: { __rl: true, mode: "list", value: "" }, event: "rowAdded", options: {} },
    },
    loopNode("Loop over rows", row(220)),
    codeNode("Build the quote render", row(440), code),
    createJob("Render the quote video", row(660), "ffmpeg", "={{ JSON.stringify($json.render_inputs) }}", "={{ $json.render_command }}"),
    waitFor("Wait for the render", row(880)),
    getJob("Download the video", row(1100), true),
    youtubeUpload("Upload to YouTube", row(1320), "={{ $('Build the quote render').item.json.quote.slice(0, 95) }}", "={{ $('Build the quote render').item.json.quote }} ({{ $('Build the quote render').item.json.author }})"),
    {
      name: "Mark the row done", type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: row(1540),
      parameters: {
        operation: "update",
        documentId: { __rl: true, mode: "list", value: "" },
        sheetName: { __rl: true, mode: "list", value: "" },
        columns: {
          mappingMode: "defineBelow",
          value: { row_number: "={{ $('Build the quote render').item.json.row_number }}", status: "done", video_id: "={{ $json.id }}" },
          matchingColumns: ["row_number"],
          schema: ["row_number", "status", "video_id"].map((id) => ({ id, displayName: id, required: false, defaultMatch: false, display: true, type: id === "row_number" ? "number" : "string", canBeUsedToMatch: true, ...(id === "row_number" ? { readOnly: true } : {}) })),
        },
        options: {},
      },
    },
  ], [
    ["Watch for new quotes", "Loop over rows"],
    ["Loop over rows", "Build the quote render", 1],
    ["Build the quote render", "Render the quote video"],
    ["Render the quote video", "Wait for the render"],
    ["Wait for the render", "Download the video"],
    ["Download the video", "Upload to YouTube"],
    ["Upload to YouTube", "Mark the row done"],
    ["Mark the row done", "Loop over rows"],
  ]);
  writeFileSync(join(OUT, "quote-videos-from-google-sheets.json"), `${JSON.stringify(wf, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// 2. Long video to captioned vertical shorts
// ---------------------------------------------------------------------------
{
  const { buildAudioRender } = moduleExports("shorts-render.js", ["buildAudioRender"]);
  const code = withModule("shorts-render.js", [
    "// Anton is a free Google Font. Swap in your own brand font as a public https URL.",
    "const FONT_URL = 'https://raw.githubusercontent.com/google/fonts/main/ofl/anton/Anton-Regular.ttf';",
    "const transcript = $('Transcribe with OpenAI').first().json;",
    "const moments = JSON.parse($input.first().json.choices[0].message.content).moments;",
    "const sourceUrl = $('Upload the video to Rendobar').first().json.url;",
    "const captions = groupWords(transcript.words ?? []);",
    "return moments.map((moment, i) => {",
    "  const render = buildShortRender(moment, captions, { sourceUrl, fontUrl: FONT_URL });",
    "  return { json: { clip: i + 1, hook: moment.hook, start: render.start, seconds: render.seconds, render_command: render.command, render_inputs: render.inputs } };",
    "});",
  ]);
  const pickBody = "={{ JSON.stringify({ model: 'gpt-4.1-mini', response_format: { type: 'json_schema', json_schema: { name: 'moments', strict: true, schema: { type: 'object', additionalProperties: false, required: ['moments'], properties: { moments: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['start', 'end', 'hook'], properties: { start: { type: 'number' }, end: { type: 'number' }, hook: { type: 'string' } } } } } } } }, messages: [ { role: 'system', content: 'You cut short-form clips from long videos. Pick up to 3 self-contained moments of 20 to 45 seconds that make sense without the rest of the video. Use start and end times from the transcript. Write a hook title of at most 40 characters for each.' }, { role: 'user', content: $json.segments.map(s => '[' + s.start.toFixed(1) + '-' + s.end.toFixed(1) + '] ' + s.text.trim()).join('\\n') } ] }) }}";
  const main = [
    "## How it works",
    "",
    "Drop a long recording into a Google Drive folder: a podcast, a webinar or an interview. The workflow finds the best moments, cuts each one into a captioned vertical clip and uploads the clips to YouTube as Shorts.",
    "",
    "Rendobar first pulls a 32 kbps mono track from the upload, small enough for the OpenAI transcription endpoint. Whisper returns word timestamps, and a GPT call picks up to three self-contained moments with a hook title for each.",
    "",
    "A Code node snaps every clip to word edges, groups the words into short captions and builds one FFmpeg command per clip. That command crops 9:16 around the speaker, burns the captions, draws the hook at the top and levels the audio to -14 LUFS. Each clip is its own Rendobar job that parks on a Wait node, so a long render costs nothing while it runs.",
    "",
    "## Setup steps",
    "",
    SETUP_KEY,
    "2. Connect Google Drive and pick the folder to watch.",
    "3. Add an OpenAI credential to both HTTP Request nodes.",
    "4. Connect YouTube in the upload node.",
    "5. Keep recordings under about 100 minutes. At 32 kbps that stays inside the 25 MB transcription limit.",
  ].join("\n");
  const openAi = { authentication: "predefinedCredentialType", nodeCredentialType: "openAiApi" };
  const wf = build("shorts", "Cut long videos into captioned vertical shorts with OpenAI and Rendobar", [
    sticky("How it works", main, [-80, -800], 700, 720),
    sticky("Section: transcribe", "### Transcribe\nRendobar pulls a small mono track from the upload. OpenAI returns word and segment timestamps from it.", [620, -60], 880, 260, 7),
    sticky("Section: pick", "### Pick the moments\nGPT reads the timed transcript and returns up to three moments, each with a start, an end and a hook title.", [1520, -60], 660, 260, 7),
    sticky("Section: cut", "### Cut each clip\nOne Rendobar job per clip does the crop, captions, hook and loudness in a single FFmpeg command. The loop waits for each callback, then uploads the Short.", [2200, -60], 1100, 260, 7),
    driveTrigger("Watch the recordings folder", row(0)),
    driveDownload("Download the recording", row(220)),
    uploadFile("Upload the video to Rendobar", row(440)),
    createJob("Extract the audio", row(660), "ffmpeg", "={{ JSON.stringify({ source: $json.url }) }}", buildAudioRender().command),
    waitFor("Wait for the audio", row(880)),
    getJob("Download the audio", row(1100), true),
    {
      name: "Transcribe with OpenAI", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: row(1320),
      parameters: {
        method: "POST", url: "https://api.openai.com/v1/audio/transcriptions", ...openAi,
        sendBody: true, contentType: "multipart-form-data",
        bodyParameters: { parameters: [
          { parameterType: "formBinaryData", name: "file", inputDataFieldName: "data" },
          { name: "model", value: "whisper-1" },
          { name: "response_format", value: "verbose_json" },
          { name: "timestamp_granularities[]", value: "word" },
          { name: "timestamp_granularities[]", value: "segment" },
        ] },
        options: {},
      },
    },
    {
      name: "Pick the moments", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: row(1540),
      parameters: { method: "POST", url: "https://api.openai.com/v1/chat/completions", ...openAi, sendBody: true, specifyBody: "json", jsonBody: pickBody, options: {} },
    },
    codeNode("Build the clip renders", row(1760), code, "runOnceForAllItems"),
    loopNode("Loop over clips", row(1980)),
    createJob("Cut the clip", row(2200), "ffmpeg", "={{ JSON.stringify($json.render_inputs) }}", "={{ $json.render_command }}"),
    waitFor("Wait for the clip", row(2420)),
    getJob("Download the clip", row(2640), true),
    youtubeUpload("Upload the Short", row(2860), "={{ $('Build the clip renders').item.json.hook }} #Shorts", "Clip {{ $('Build the clip renders').item.json.clip }} from {{ $('Watch the recordings folder').first().json.name }}"),
  ], [
    ["Watch the recordings folder", "Download the recording"],
    ["Download the recording", "Upload the video to Rendobar"],
    ["Upload the video to Rendobar", "Extract the audio"],
    ["Extract the audio", "Wait for the audio"],
    ["Wait for the audio", "Download the audio"],
    ["Download the audio", "Transcribe with OpenAI"],
    ["Transcribe with OpenAI", "Pick the moments"],
    ["Pick the moments", "Build the clip renders"],
    ["Build the clip renders", "Loop over clips"],
    ["Loop over clips", "Cut the clip", 1],
    ["Cut the clip", "Wait for the clip"],
    ["Wait for the clip", "Download the clip"],
    ["Download the clip", "Upload the Short"],
    ["Upload the Short", "Loop over clips"],
  ]);
  writeFileSync(join(OUT, "captioned-shorts-from-long-videos.json"), `${JSON.stringify(wf, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// 3. Listing photos to a vertical video tour
// ---------------------------------------------------------------------------
{
  const code = withModule("listing-render.js", [
    "// Your brand: a licensed music track and two fonts, each a public https URL.",
    "const BRAND = {",
    "  music_url: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Wallpaper.mp3',",
    "  display_font_url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf',",
    "  body_font_url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosans/NotoSans%5Bwdth,wght%5D.ttf',",
    "};",
    "const form = $json;",
    "const listing = {",
    "  ...BRAND,",
    "  photos: String(form['Photo URLs'] ?? '').split(/\\s+/).filter((url) => /^https:\\/\\//.test(url)),",
    "  price: form['Price'],",
    "  address: form['Address'],",
    "  beds: form['Bedrooms'],",
    "  baths: form['Bathrooms'],",
    "  sqft: form['Square feet'],",
    "  agent_name: form['Agent name'],",
    "  agent_phone: form['Agent phone'],",
    "  brokerage: form['Brokerage'],",
    "};",
    "const render = buildListingRender(listing);",
    "return { json: { address: listing.address, agent_email: form['Agent email'], seconds: render.seconds, render_command: render.command, render_inputs: render.inputs } };",
  ]);
  const main = [
    "## How it works",
    "",
    "An agent fills in a form with the listing details, links to the photos and their contact details. The workflow turns it into a vertical video tour for Reels, TikTok and Shorts, saves it to Google Drive and emails it to the agent.",
    "",
    "A Code node builds one FFmpeg command for the whole tour. Every photo gets its own camera move, a push in, a pull out or a pan, and the photos crossfade into each other. Price, address and room counts sit on a soft gradient along the bottom, and the tour ends on a card with the agent's name, phone and brokerage over a blurred copy of the hero photo. The text travels as files, so a price like $1,250,000 or an address with an apostrophe renders exactly as typed.",
    "",
    "Rendobar renders the tour while the Wait node parks the execution. Five photos make a video of about 16 seconds.",
    "",
    "## Setup steps",
    "",
    SETUP_KEY,
    "2. In the Code node, set your music track and fonts. The default track is Wallpaper by Kevin MacLeod (incompetech.com) under CC BY 4.0, so credit it or use your own.",
    "3. Connect Google Drive and Gmail.",
    "4. Share the form URL with your agents. Photos must be public https links with the hero shot first. Portrait photos fill the frame best.",
  ].join("\n");
  const field = (fieldLabel, fieldType, placeholder) => ({ fieldLabel, fieldType, requiredField: true, ...(placeholder ? { placeholder } : {}) });
  const wf = build("listing", "Turn listing photos into a vertical video tour for real estate with Rendobar", [
    sticky("How it works", main, [-80, -800], 700, 720),
    sticky("Section: build", "### Build the tour\nThe Code node maps the form to photos, text and your brand settings, then builds the FFmpeg command.", [180, -60], 440, 260, 7),
    sticky("Section: deliver", "### Render and deliver\nRendobar renders while the execution parks. Get downloads the video, then Drive keeps a copy and Gmail sends it to the agent.", [640, -200], 700, 460, 7),
    {
      name: "Listing form", type: "n8n-nodes-base.formTrigger", typeVersion: 2.2, position: row(0), webhook: true,
      parameters: {
        formTitle: "Make a listing video tour",
        formDescription: "Paste public photo links, one per line, hero shot first. The finished tour arrives by email.",
        formFields: { values: [
          field("Address", "text", "12 Example Court, Springfield"),
          field("Price", "text", "$845,000"),
          field("Bedrooms", "number"),
          field("Bathrooms", "number"),
          field("Square feet", "number"),
          field("Photo URLs", "textarea", "https://example.com/photo-1.jpg"),
          field("Agent name", "text"),
          field("Agent phone", "text"),
          field("Brokerage", "text"),
          field("Agent email", "email"),
        ] },
        options: {},
      },
    },
    codeNode("Build the tour render", row(220), code),
    createJob("Render the tour", row(440), "ffmpeg", "={{ JSON.stringify($json.render_inputs) }}", "={{ $json.render_command }}"),
    waitFor("Wait for the render", row(660)),
    getJob("Download the tour", row(880), true),
    {
      name: "Save the tour to Drive", type: "n8n-nodes-base.googleDrive", typeVersion: 3, position: row(1100, -80),
      parameters: { name: "={{ $('Build the tour render').item.json.address }} tour.mp4", driveId: { __rl: true, mode: "list", value: "My Drive" }, folderId: { __rl: true, mode: "list", value: "root", cachedResultName: "/ (Root folder)" }, options: {} },
    },
    {
      name: "Email the agent", type: "n8n-nodes-base.gmail", typeVersion: 2.1, position: row(1100, 160),
      parameters: {
        sendTo: "={{ $('Build the tour render').item.json.agent_email }}",
        subject: "=Your video tour for {{ $('Build the tour render').item.json.address }}",
        emailType: "text",
        message: "=The vertical video tour is attached, {{ $('Build the tour render').item.json.seconds }} seconds long and ready for Reels, TikTok and Shorts. A copy is in Google Drive.",
        options: { attachmentsUi: { attachmentsBinary: [{ property: "data" }] } },
      },
    },
  ], [
    ["Listing form", "Build the tour render"],
    ["Build the tour render", "Render the tour"],
    ["Render the tour", "Wait for the render"],
    ["Wait for the render", "Download the tour"],
    // Drive and Gmail both take the downloaded file. Chained, Gmail would get Drive's metadata and no attachment.
    ["Download the tour", "Save the tour to Drive"],
    ["Download the tour", "Email the agent"],
  ]);
  writeFileSync(join(OUT, "listing-photos-to-video-tour.json"), `${JSON.stringify(wf, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// 4. Upload QC with thumbnail and GIF preview
// ---------------------------------------------------------------------------
{
  const code = withModule("upload-qc.js", [
    "// Your rules. A team shooting vertical 4K would set minShortSide to 2160, for example.",
    "const RULES = { minShortSide: 1080, maxDurationSec: 600, requireAudio: true, minFps: 23 };",
    "const qc = checkUpload($json.data ?? {}, RULES);",
    "const video = $('Upload the video to Rendobar').item.json.url;",
    "const thumbnail = buildThumbnailRender();",
    "const gif = buildGifRender(qc.duration);",
    "return { json: {",
    "  file_name: $('Watch the uploads folder').item.json.name,",
    "  passed: qc.passed,",
    "  failed: qc.failed,",
    "  report: qc.checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.check}: ${c.value} (${c.rule})`).join('\\n'),",
    "  thumbnail_command: thumbnail.command,",
    "  thumbnail_inputs: { video, ...thumbnail.inputs },",
    "  gif_command: gif.command,",
    "  gif_inputs: { video, ...gif.inputs },",
    "} };",
  ]);
  const main = [
    "## How it works",
    "",
    "Every video that lands in a Google Drive folder gets checked before anyone uses it. The workflow runs ffprobe on Rendobar, checks the file against your rules and posts the result to Slack, with a poster frame and a looping GIF when the file passes.",
    "",
    "The check reads resolution, duration, audio, codec, frame rate and dynamic range from the ffprobe report. The rules live in one object in the Code node, so a team that needs 4K, a length limit or silent clips changes one line. A file that fails goes to Slack with the list of failed checks and nothing else runs.",
    "",
    "A file that passes gets two more Rendobar jobs. FFmpeg's thumbnail filter scores 120 frames from the first minute and keeps the most representative one, so the poster is never a black fade. The GIF comes from the middle of the video with error-diffusion dithering, so skies do not show a dot grid. Each job parks on a Wait node until Rendobar calls back.",
    "",
    "## Setup steps",
    "",
    SETUP_KEY,
    "2. Connect Google Drive and pick the folder to watch.",
    "3. Connect Slack and pick the channel in all three Slack nodes.",
    "4. Adjust the rules in the Check the upload node.",
  ].join("\n");
  const check = (field) => `={{ JSON.stringify($('Check the upload').item.json.${field}) }}`;
  const wf = build("qc", "Check Drive video uploads and post thumbnail and GIF previews with Rendobar", [
    sticky("How it works", main, [-80, -800], 700, 720),
    sticky("Section: probe", "### Probe and check\nRendobar runs ffprobe on the upload and the Code node compares the report with your rules.", [620, -60], 1100, 260, 7),
    sticky("Section: previews", "### Previews\nTwo more jobs make a poster frame and a GIF. Each waits for its callback, then goes to Slack.", [1960, -200], 1780, 240, 7),
    sticky("Section: failed", "### Failed checks\nA file that fails a rule goes straight to Slack with the list of failed checks.", [1960, 220], 440, 240, 7),
    driveTrigger("Watch the uploads folder", row(0)),
    driveDownload("Download the upload", row(220)),
    uploadFile("Upload the video to Rendobar", row(440)),
    createJob("Probe the video", row(660), "ffprobe", "={{ JSON.stringify({}) }}", "={{ $json.url }}"),
    waitFor("Wait for the probe", row(880)),
    getJob("Read the probe report", row(1100), false),
    codeNode("Check the upload", row(1320), code),
    {
      name: "Passed every check?", type: "n8n-nodes-base.if", typeVersion: 2.2, position: row(1540),
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
          conditions: [{ id: uuid("qc:passed-condition"), leftValue: "={{ $json.passed }}", rightValue: "", operator: { type: "boolean", operation: "true", singleValue: true } }],
          combinator: "and",
        },
        options: {},
      },
    },
    createJob("Make the thumbnail", row(1760, -80), "ffmpeg", check("thumbnail_inputs"), "={{ $('Check the upload').item.json.thumbnail_command }}"),
    waitFor("Wait for the thumbnail", row(1980, -80)),
    getJob("Download the thumbnail", row(2200, -80), true),
    slackUpload("Post the thumbnail to Slack", row(2420, -80), "={{ $('Check the upload').item.json.file_name }} passed upload QC\n{{ $('Check the upload').item.json.report }}"),
    createJob("Make the GIF preview", row(2640, -80), "ffmpeg", check("gif_inputs"), "={{ $('Check the upload').item.json.gif_command }}"),
    waitFor("Wait for the GIF", row(2860, -80)),
    getJob("Download the GIF", row(3080, -80), true),
    slackUpload("Post the GIF to Slack", row(3300, -80), "=Preview of {{ $('Check the upload').item.json.file_name }}"),
    slackPost("Post the failed checks to Slack", row(1760, 320), "={{ $json.file_name }} failed upload QC: {{ $json.failed.join(', ') }}\n```\n{{ $json.report }}\n```"),
  ], [
    ["Watch the uploads folder", "Download the upload"],
    ["Download the upload", "Upload the video to Rendobar"],
    ["Upload the video to Rendobar", "Probe the video"],
    ["Probe the video", "Wait for the probe"],
    ["Wait for the probe", "Read the probe report"],
    ["Read the probe report", "Check the upload"],
    ["Check the upload", "Passed every check?"],
    ["Passed every check?", "Make the thumbnail", 0],
    ["Passed every check?", "Post the failed checks to Slack", 1],
    ["Make the thumbnail", "Wait for the thumbnail"],
    ["Wait for the thumbnail", "Download the thumbnail"],
    ["Download the thumbnail", "Post the thumbnail to Slack"],
    ["Post the thumbnail to Slack", "Make the GIF preview"],
    ["Make the GIF preview", "Wait for the GIF"],
    ["Wait for the GIF", "Download the GIF"],
    ["Download the GIF", "Post the GIF to Slack"],
  ]);
  writeFileSync(join(OUT, "video-upload-qc-with-previews.json"), `${JSON.stringify(wf, null, 2)}\n`);
}

console.log(`wrote 4 templates to ${OUT}`);
