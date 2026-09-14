# Workflow templates

Ready-to-import n8n workflows built on the Rendobar node. Each one is also
submitted to the n8n template library, where it appears on the
[Rendobar integration page](https://n8n.io/integrations/rendobar/) once n8n
approves it.

Import one with **Workflows > Import from File**, add your Rendobar API
credential on the Rendobar nodes, connect the other apps it names, and run it.
Every template runs on n8n Cloud. None of them needs FFmpeg installed or the
Execute Command node.

| Template | What it does | Rendobar operations |
|---|---|---|
| [Compress Google Drive videos under 25 MB and send them to Telegram](./compress-drive-videos-to-25mb-telegram.json) | New file in a Drive folder, compressed to a size cap, saved back and sent to a chat. | File Upload, Job Create (`compress.target`), Job Get |
| [Auto-caption Google Drive videos and post the link to Slack](./auto-caption-drive-videos-slack.json) | New file in a Drive folder, subtitles transcribed and burned in, link posted. | File Upload, Job Create (`caption.burn`), Job Get |
| [Run FFmpeg commands on n8n Cloud with Google Drive and Slack](./run-ffmpeg-on-n8n-cloud.json) | A form takes a URL and a command. Failed jobs post their FFmpeg log to Slack. | Job Create (`ffmpeg`), Job Get, Job Get Logs, Trigger on `job.failed` |
| [Create YouTube quote videos in any language from Google Sheets](./quote-videos-from-google-sheets.json) | A new sheet row becomes a 9:16 quote video with music in any script, uploaded to YouTube. | Job Create (`ffmpeg`), Job Get |
| [Cut long videos into captioned vertical shorts with OpenAI](./captioned-shorts-from-long-videos.json) | A new recording in Drive is transcribed, and its best moments become captioned 9:16 Shorts. | File Upload, Job Create (`ffmpeg`), Job Get |
| [Turn listing photos into a vertical video tour for real estate](./listing-photos-to-video-tour.json) | A form with photo links and listing details becomes a tour with an agent end card, emailed to the agent. | Job Create (`ffmpeg`), Job Get |
| [Check Drive video uploads and post thumbnail and GIF previews](./video-upload-qc-with-previews.json) | A new file in Drive is checked against your rules, and its poster frame and GIF go to Slack. | File Upload, Job Create (`ffprobe`, `ffmpeg`), Job Get |

Every template uses the same waiting shape. The Create node carries the Wait node's
resume URL as its callback, the execution parks with no worker held open, and
Rendobar's callback resumes it. The README's
[Long jobs](../README.md#long-jobs-a-callback-and-a-wait-node) section explains
the two Wait node settings that make it safe.

## Submitting to the n8n template library

The Creator Portal at https://creators.n8n.io takes one template at a time
until three are approved. Paste the workflow JSON, then the matching
description below. Titles stay under 80 characters, in sentence case, and name
the apps involved. The yellow sticky note in each workflow carries the
"How it works" and "Setup steps" sections the reviewers look for.

### Compress Google Drive videos under 25 MB with Rendobar and send them to Telegram

Who it is for: anyone who needs a video to fit under a size ceiling. Whisper
transcription stops at 25 MB, and so do many chat and email attachments.

How it works: a Google Drive trigger fires on a new file, Drive downloads it,
and Rendobar's Upload turns the binary into a URL. Create Job runs
`compress.target` with a 25 MB cap and a 1080p ceiling, carrying the Wait node's
resume URL as its callback. The execution parks, Rendobar calls back when the
job completes, Get Job downloads the file, and the small copy goes to Drive and
Telegram.

Setup: a Rendobar API key (free account at rendobar.com), Google Drive and
Telegram credentials, the folder to watch, the folder to save into, and the
Telegram chat ID. Change the size string in the Create node for a different cap.

### Auto-caption Google Drive videos with Rendobar and post the link to Slack

Who it is for: anyone publishing video with subtitles who does not want a
desktop editor in the loop.

How it works: a Google Drive trigger fires on a new file, Drive downloads it,
and Rendobar's Upload turns the binary into a URL. Create Job runs
`caption.burn` with the language on auto, so Rendobar transcribes the audio in
any language and renders the captions with an outline and a translucent box.
The job carries the Wait node's resume URL as its callback, the execution parks,
and Get Job downloads the captioned video when Rendobar calls back. The copy
goes to Drive and the link to Slack.

Setup: a Rendobar API key (free account at rendobar.com), Google Drive and
Slack credentials, the folder to watch, the folder to save into, and the Slack
channel. Font, size, colours, box and position are fields on the Create node.
Pass an SRT or VTT as the `subtitles` input to burn your own file instead.

### Run FFmpeg commands on n8n Cloud with Rendobar, Google Drive and Slack

Ready to submit. Categories: Marketing > Content Creation. Paste this description:

```markdown
## Who is this for
Anyone on n8n Cloud who needs FFmpeg, and anyone on self-hosted n8n 2.x, where the Execute Command node is off by default.

## How it works
1. An n8n Form takes a video URL and an FFmpeg command.
2. The Rendobar node runs the command on Rendobar's workers with the full FFmpeg build. The command names its input `source` and its output `output.mp4`, the same way you would type it on your own machine.
3. A Wait node parks the execution until Rendobar calls back, so nothing polls.
4. The output is saved to Google Drive and the link is posted to Slack.
5. A second branch starts whenever a job fails, reads the FFmpeg log and posts the error to Slack.

## Setup
1. Create a free account at rendobar.com, make an API key, and add it as a Rendobar credential on every Rendobar node.
2. Connect Google Drive and pick the folder in the Save node.
3. Connect Slack and pick the channel in both Slack nodes.
4. Open the form URL and try `-i source -vf scale=-2:720 -c:v libx264 -crf 28 output.mp4`.

## Requirements
- A Rendobar account
- Google Drive and Slack accounts
- A public video URL

## How to customize
- Change the command for trims, GIFs, audio extraction or any other FFmpeg task.
- Swap the Drive node for S3, Dropbox or email, or remove Slack if you only need the file.
```

### Create YouTube quote videos in any language from Google Sheets with Rendobar

Ready to submit. Categories: Marketing > Content Creation, Marketing > Social Media. Paste this description:

```markdown
## Who is this for
Faceless channels, creators and brands that post daily quote Shorts. It runs on n8n Cloud, with no FFmpeg install and no Execute Command node, and handles languages most quote workflows break on, like Arabic, Thai, Hindi or Japanese.

## How it works
1. A Google Sheets trigger fires on each new row, and a loop renders rows one at a time.
2. A Code node wraps the quote into balanced lines and picks a font made for the row's language: 28 languages, from Montserrat for English to Cairo for Arabic, Kanit for Thai and Noto Sans JP for Japanese.
3. An HTTP Request node fetches that font from Google Fonts.
4. Rendobar renders a 10 second 1080x1920 video: a slow push-in on your background clip, lines that fade in one after another, full text shaping so Arabic letters join, and a music bed.
5. A Wait node parks the execution until Rendobar calls back. The video then uploads to YouTube as private and the row is marked done.

## Setup
1. Create a free account at rendobar.com, make an API key, and add it as a Rendobar credential.
2. Make a sheet with the columns quote, author, language, background_url, music_url, font, font_url, font_family, status and video_id.
3. Connect Google Sheets in both Sheets nodes and YouTube in the upload node.

## Requirements
- A Rendobar account
- Google Sheets and YouTube accounts
- A background clip of at least 10 seconds and a music track, as public https links

## How to customize
- Leave font empty for the language default, type any Google Fonts family, or link your own .ttf in font_url with its family name in font_family.
- Change the duration, zoom or text colors in the Build the quote render node.
```

If a Google font does not show, set font_family to the name inside the font file. A few files differ from their Google Fonts name, for example Nanum Gothic's file says NanumGothic.

### Cut long videos into captioned vertical shorts with OpenAI and Rendobar

Who it is for: podcasters, webinar hosts and agencies turning long recordings
into Shorts.

How it works: a Google Drive trigger fires on a new recording, Drive downloads
it and Rendobar's Upload turns it into a URL. A first Rendobar job pulls a
32 kbps mono track, which OpenAI transcribes with word timestamps, and a GPT call
picks up to three self-contained moments with a hook title each. A Code node
snaps every clip to word edges, groups the words into short captions and builds
one FFmpeg command per clip. That command crops to 9:16, burns the captions,
draws the hook and levels the audio to -14 LUFS. A loop runs one Rendobar job
per clip, parks on the Wait node for each callback and uploads the Short.

Setup: a Rendobar API key (free account at rendobar.com), Google Drive, OpenAI
and YouTube credentials, and the folder to watch. Keep recordings under about
100 minutes, so the audio stays inside the 25 MB transcription limit.

### Turn listing photos into a vertical video tour for real estate with Rendobar

Who it is for: real estate agents and brokerages that want a Reels or TikTok
tour for every listing without an editor.

How it works: an n8n Form collects the address, price, room counts, photo links
and the agent's contact details. A Code node builds one FFmpeg command with a
different camera move per photo, crossfades, the listing details on a soft
gradient, and an end card with the agent's name, phone and brokerage over the
blurred hero photo. Create Job renders it with the Wait node's resume URL as its
callback. Get Job downloads the tour, Drive keeps it and Gmail sends it to the
agent.

Setup: a Rendobar API key (free account at rendobar.com), plus Google Drive and
Gmail credentials. Set your music track and fonts in the Code node. The default
track is Wallpaper by Kevin MacLeod under CC BY 4.0, so credit it or replace it.

### Check Drive video uploads and post thumbnail and GIF previews with Rendobar

Who it is for: teams that receive video from clients or contributors and need to
catch a low resolution, a missing audio track or an over-long file before anyone
edits it.

How it works: a Google Drive trigger fires on a new file, Drive downloads it and
Rendobar's Upload turns it into a URL. Create Job runs ffprobe, and a Code node
checks resolution, duration, audio, codec, frame rate and dynamic range against
rules you set. A file that fails goes to Slack with the list of failed checks. A
file that passes gets two more Rendobar jobs: a poster frame chosen by FFmpeg's
thumbnail filter, and a GIF preview from the middle of the video. Both go to
Slack.

Setup: a Rendobar API key (free account at rendobar.com), Google Drive and
Slack credentials, the folder to watch and the Slack channel. Change the rules
object in the Check the upload node.
