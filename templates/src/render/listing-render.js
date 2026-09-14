// Code node body for "Listing photos to a video tour". Embedded verbatim in the
// n8n template and evaluated by the local test runner.
// Input: one listing. Output: the Rendobar ffmpeg job's command and inputs.
function buildListingRender(listing) {
  const W = 1080;
  const H = 1920;
  const FPS = 30;
  const PER = 3.2; // seconds each photo is on screen
  const XF = 0.7; // crossfade length
  const END = 3.4; // agent end card
  const photos = (listing.photos ?? []).filter(Boolean);
  if (photos.length < 3 || photos.length > 12) throw new Error('A tour needs 3 to 12 photos');
  for (const key of ['music_url', 'display_font_url', 'body_font_url']) {
    if (!/^https:\/\//.test(String(listing[key] ?? ''))) throw new Error(`${key} must be an https URL`);
  }
  const n = photos.length;
  const frames = Math.round(PER * FPS);
  const endFrames = Math.round(END * FPS);

  // A different move per photo, so the tour does not feel mechanical.
  const center = { x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)' };
  const motions = [
    { z: `1+0.14*on/${frames}`, ...center },
    { z: `1.14-0.14*on/${frames}`, ...center },
    { z: '1.12', x: `(iw-iw/zoom)*on/${frames}`, y: center.y },
    { z: '1.12', x: `(iw-iw/zoom)*(1-on/${frames})`, y: center.y },
  ];

  const inputs = {};
  // The end card reuses the first photo, which is the hero shot of a listing.
  const graph = [`[0:v]split=2[first][cardsrc]`];
  photos.forEach((url, i) => {
    inputs[`photo${i + 1}`] = url;
    const m = motions[i % motions.length];
    const src = i === 0 ? '[first]' : `[${i}:v]`;
    graph.push(
      `${src}scale=2160:3840:force_original_aspect_ratio=increase,crop=2160:3840,` +
        `zoompan=z='${m.z}':x='${m.x}':y='${m.y}':d=${frames}:s=${W}x${H}:fps=${FPS},setsar=1,format=yuv420p[p${i}]`,
    );
  });

  let prev = 'p0';
  let offset = 0;
  for (let i = 1; i < n; i++) {
    offset += PER - XF;
    graph.push(`[${prev}][p${i}]xfade=transition=fade:duration=${XF}:offset=${offset.toFixed(2)}[x${i}]`);
    prev = `x${i}`;
  }
  const tourLength = offset + PER;
  const total = tourLength - XF + END;

  const text = (file, font, size, x, y, start, color = 'white') =>
    `drawtext=fontfile=${font}:textfile=${file}:expansion=none:fontsize=${size}:fontcolor=${color}` +
    `:x=${x}:y=${y}:alpha='clip((t-${start})/0.6,0,1)'`;
  const specs = `${listing.beds} bd · ${listing.baths} ba · ${Number(listing.sqft).toLocaleString('en-US')} sq ft`;
  Object.assign(inputs, {
    music: listing.music_url,
    'display.ttf': listing.display_font_url,
    'body.ttf': listing.body_font_url,
    'price.txt': { content: String(listing.price) },
    'address.txt': { content: String(listing.address) },
    'specs.txt': { content: specs },
    'agent.txt': { content: String(listing.agent_name) },
    'phone.txt': { content: String(listing.agent_phone) },
    'brokerage.txt': { content: String(listing.brokerage) },
  });

  // Listing details sit on a soft dark gradient along the bottom of the tour.
  graph.push(`gradients=s=${W}x760:c0=0x00000000:c1=0x000000d9:x0=0:y0=0:x1=0:y1=760:n=2:r=${FPS}:d=${tourLength.toFixed(2)}[fade]`);
  graph.push(
    `[${prev}][fade]overlay=0:${H - 760}:shortest=1,` +
      [
        text('price.txt', 'display.ttf', 104, 72, H - 540, 0.5),
        text('address.txt', 'body.ttf', 46, 76, H - 390, 0.8),
        text('specs.txt', 'body.ttf', 40, 76, H - 318, 1.1, 'white@0.88'),
      ].join(',') +
      '[tour]',
  );
  graph.push(
    `[cardsrc]scale=2160:3840:force_original_aspect_ratio=increase,crop=2160:3840,boxblur=40:2,eq=brightness=-0.44,` +
      `zoompan=z=1:d=${endFrames}:s=${W}x${H}:fps=${FPS},setsar=1,format=yuv420p,` +
      [
        text('agent.txt', 'display.ttf', 100, '(w-text_w)/2', 750, 0.5),
        text('phone.txt', 'body.ttf', 58, '(w-text_w)/2', 895, 0.8, 'white@0.92'),
        text('brokerage.txt', 'body.ttf', 46, '(w-text_w)/2', 985, 1.1, 'white@0.78'),
      ].join(',') +
      '[card]',
  );
  graph.push(`[tour][card]xfade=transition=fade:duration=${XF}:offset=${(tourLength - XF).toFixed(2)}[v]`);
  graph.push(`[${n}:a]atrim=0:${total.toFixed(2)},asetpts=PTS-STARTPTS,afade=t=in:d=0.8,afade=t=out:st=${(total - 1.8).toFixed(2)}:d=1.8[a]`);

  const photoArgs = photos.map((_, i) => `-i photo${i + 1}`).join(' ');
  const command =
    `${photoArgs} -i music -filter_complex "${graph.join(';')}" -map "[v]" -map "[a]" ` +
    `-c:v libx264 -preset veryfast -crf 21 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart tour.mp4`;
  return { command, inputs, seconds: Number(total.toFixed(2)) };
}
