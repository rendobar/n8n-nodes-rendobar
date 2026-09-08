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
| [Run any FFmpeg command on n8n Cloud and save the output to Google Drive](./run-ffmpeg-on-n8n-cloud.json) | A form takes a URL and a command. Failed jobs post their FFmpeg log to Slack. | Job Create (`ffmpeg`), Job Get, Job Get Logs, Trigger on `job.failed` |

All three use the same waiting shape. The Create node carries the Wait node's
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

### Run any FFmpeg command on n8n Cloud with Rendobar and save the output to Google Drive

Who it is for: anyone on n8n Cloud, or on a self-hosted n8n 2.x where Execute
Command is off, who needs to run an FFmpeg command.

How it works: an n8n Form takes a video URL and an FFmpeg command. The command
names its input `source` and its output `output.mp4`, and Create Job runs it as
an `ffmpeg` job on Rendobar's workers with the Wait node's resume URL as the
callback. The execution parks, Get Job downloads the output when Rendobar calls
back, and the file goes to Drive with the link posted to Slack. A second branch
starts on any failed job, reads the runner log with Get Logs, and posts the
FFmpeg error text to Slack.

Setup: a Rendobar API key (free account at rendobar.com), Google Drive and
Slack credentials, the folder to save into, and the Slack channel. Open the
form URL from the trigger to submit a job.
