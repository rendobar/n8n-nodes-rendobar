// Code node bodies for "Drive video upload QC with thumbnail and GIF preview".
// Embedded verbatim in the n8n template and evaluated by the local test runner.

// Turn Rendobar's ffprobe output into pass/fail checks a team can act on.
function checkUpload(probe, rules = {}) {
  const r = { minShortSide: 1080, maxDurationSec: 600, requireAudio: true, allowedCodecs: ['h264', 'hevc', 'vp9', 'av1'], minFps: 23, ...rules };
  const summary = probe.summary ?? {};
  const video = summary.video ?? {};
  const stream = (probe.streams ?? []).find((s) => s.codec_type === 'video') ?? {};
  const [num, den] = String(stream.avg_frame_rate || stream.r_frame_rate || '0/1').split('/').map(Number);
  const fps = video.fps ?? (den ? num / den : 0);
  const shortSide = Math.min(video.width ?? 0, video.height ?? 0);
  const duration = Number(summary.durationSec ?? 0);
  const audioCount = summary.streamCounts?.audio ?? 0;
  const checks = [
    { check: 'Resolution', value: `${video.width}x${video.height}`, rule: `short side at least ${r.minShortSide} px`, pass: shortSide >= r.minShortSide },
    { check: 'Duration', value: `${duration.toFixed(1)} s`, rule: `at most ${r.maxDurationSec} s`, pass: duration > 0 && duration <= r.maxDurationSec },
    { check: 'Audio', value: audioCount ? (summary.audio?.codec ?? 'present') : 'none', rule: 'has an audio track', pass: !r.requireAudio || audioCount > 0 },
    { check: 'Video codec', value: video.codec ?? 'none', rule: r.allowedCodecs.join(', '), pass: r.allowedCodecs.includes(video.codec) },
    { check: 'Frame rate', value: fps ? `${Number(fps).toFixed(2)} fps` : 'unknown', rule: `at least ${r.minFps} fps`, pass: fps >= r.minFps },
    { check: 'Dynamic range', value: video.isHdr ? 'HDR' : 'SDR', rule: 'SDR', pass: !video.isHdr },
  ];
  return { passed: checks.every((c) => c.pass), failed: checks.filter((c) => !c.pass).map((c) => c.check), checks, duration };
}

// Poster frame: FFmpeg's thumbnail filter scores 120 frames sampled over the first
// minute and keeps the most representative one, so fades and black frames lose.
function buildThumbnailRender() {
  return {
    command: '-ss 3 -t 60 -i video -vf "fps=2,thumbnail=120,scale=1280:-2" -frames:v 1 -q:v 2 thumbnail.jpg',
    inputs: {},
  };
}

// Looping preview from the middle of the video, with error-diffusion dithering
// and a palette tuned to what moves, so skies do not show a dot grid.
function buildGifRender(duration) {
  const start = Math.max(0, Math.round(duration * 0.55 * 10) / 10);
  return {
    command:
      `-ss ${start} -t 4 -i video -filter_complex "fps=12,scale=480:-1:flags=lanczos,split[a][b];` +
      `[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle" -loop 0 preview.gif`,
    inputs: {},
  };
}
