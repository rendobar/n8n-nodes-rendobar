// Code node bodies for "Long video to vertical shorts with captions". Embedded
// verbatim in the n8n template and evaluated by the local test runner.

// Step 1 job: a small mono 16 kHz track, the size a transcription API wants.
function buildAudioRender() {
  return { command: '-i source -vn -ac 1 -ar 16000 -c:a libmp3lame -b:a 32k audio.mp3', inputs: {} };
}

// Group word timestamps (OpenAI Whisper verbose_json with word granularity) into
// caption chunks of up to three words, breaking at sentence ends and pauses.
function groupWords(words, maxWords = 3, maxChars = 16) {
  const chunks = [];
  let current = null;
  for (const w of words) {
    const text = String(w.word ?? '').trim();
    if (!text) continue;
    if (current && (current.count >= maxWords || `${current.text} ${text}`.length > maxChars || w.start - current.end > 0.6)) {
      chunks.push(current);
      current = null;
    }
    current = current
      ? { start: current.start, end: w.end, text: `${current.text} ${text}`, count: current.count + 1 }
      : { start: w.start, end: w.end, text, count: 1 };
    if (/[.?!]$/.test(text)) {
      chunks.push(current);
      current = null;
    }
  }
  if (current) chunks.push(current);
  return chunks.map(({ start, end, text }) => ({ start, end, text }));
}

// One 9:16 clip: crop around the speaker, burn the captions, add the hook title
// and level the audio for social playback.
function buildShortRender(moment, captions, options) {
  const W = 1080;
  const H = 1920;
  const subjectX = Math.min(1, Math.max(0, Number(moment.subject_x ?? 0.5)));
  // A caption belongs to the moment its midpoint falls in, so neighbouring clips never share a line.
  const inside = captions.filter((c) => (c.start + c.end) / 2 >= moment.start && (c.start + c.end) / 2 < moment.end);
  if (!inside.length) throw new Error(`No speech between ${moment.start} s and ${moment.end} s`);

  // Snap to caption edges, so a clip never starts or ends in the middle of a word.
  const start = Math.max(0, inside[0].start - 0.15);
  const end = inside[inside.length - 1].end + 0.35;
  const seconds = end - start;
  const stamp = (s) => {
    const ms = Math.max(0, Math.round(s * 1000));
    const pad = (v, n = 2) => String(v).padStart(n, '0');
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
  };
  const srt = inside
    .map((c, i) => `${i + 1}\n${stamp(c.start - start)} --> ${stamp(Math.min(c.end, end) - start)}\n${c.text.toUpperCase()}\n`)
    .join('\n');

  // Hook title from the AI step: up to two balanced lines of at most 22 characters,
  // kept clear of the top of the frame where the app draws its own controls.
  const hook = String(moment.hook ?? '').trim().replace(/\s+/g, ' ');
  const wrap = (limit) => {
    const out = [];
    for (const word of hook.split(' ').filter(Boolean)) {
      const last = out[out.length - 1];
      if (last && `${last} ${word}`.length <= limit) out[out.length - 1] = `${last} ${word}`;
      else out.push(word);
    }
    return out;
  };
  const balanced = wrap(Math.min(22, (hook.length / Math.max(1, Math.ceil(hook.length / 22))) * 1.15));
  const hookLines = balanced.length <= 2 ? balanced : wrap(22);
  if (hookLines.length > 2) throw new Error('The hook needs to fit on two lines, about 40 characters');

  const inputs = { source: options.sourceUrl, 'captions.srt': { content: srt }, 'Anton-Regular.ttf': options.fontUrl };
  const video = [
    `crop=w=trunc(ih*9/16/2)*2:h=ih:x='min(max(0,iw*${subjectX.toFixed(3)}-ow/2),iw-ow)'`,
    `scale=${W}:${H}:flags=lanczos`,
    'setsar=1',
    "subtitles=captions.srt:fontsdir=.:force_style='FontName=Anton,FontSize=19,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1.6,Shadow=0.8,Alignment=2,MarginV=105'",
  ];
  hookLines.forEach((line, i) => {
    inputs[`hook${i + 1}.txt`] = { content: line.toUpperCase() };
    video.push(
      `drawtext=fontfile=Anton-Regular.ttf:textfile=hook${i + 1}.txt:expansion=none:fontsize=84:fontcolor=black` +
        `:box=1:boxcolor=white@0.96:boxborderw=22:x=(w-text_w)/2:y=${250 + i * 132}:alpha='clip((t-0.2)/0.4,0,1)'`,
    );
  });
  const graph = `[0:v]${video.join(',')}[v];[0:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]`;
  const command =
    `-ss ${start.toFixed(2)} -t ${seconds.toFixed(2)} -i source -filter_complex "${graph}" -map "[v]" -map "[a]" ` +
    `-c:v libx264 -preset veryfast -crf 21 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart short.mp4`;
  return { command, inputs, start: Number(start.toFixed(2)), seconds: Number(seconds.toFixed(2)) };
}
