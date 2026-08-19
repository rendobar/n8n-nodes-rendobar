# @rendobar/n8n-nodes-rendobar

n8n community node for [Rendobar](https://rendobar.com), a media processing API. Submit, track, and cancel video jobs from your workflows, and start workflows when jobs finish.

[n8n](https://n8n.io) is a fair-code workflow automation platform.

## Contents

- [Installation](#installation)
- [Credentials](#credentials)
- [Nodes](#nodes)
- [Job result](#job-result-the-same-shape-for-every-job-type)
- [When something goes wrong](#when-something-goes-wrong)
- [Example workflows](#example-workflows)
- [Compatibility](#compatibility)
- [Troubleshooting](#troubleshooting)
- [Resources](#resources)

## Installation

In n8n, go to **Settings > Community Nodes** and install `@rendobar/n8n-nodes-rendobar`. See the n8n [community nodes docs](https://docs.n8n.io/integrations/community-nodes/installation/) for details.

## Credentials

You need a Rendobar API key (starts with `rb_`). Create one in the [dashboard](https://app.rendobar.com). The connection is validated against your account when you save it.

- **API Key**: your `rb_` key. Stored as a password field and never written to the workflow.
- **Base URL**: defaults to `https://api.rendobar.com`. Change it only to reach a non-production Rendobar environment.

## Nodes

### Rendobar (action)

Operations are grouped by resource.

#### Resource: Job

- **Create**: submit a job.
  - The **Job Type** dropdown is loaded live from your account, and the parameter fields are discovered from the API, so new job types appear without updating this node.
  - Each submission sends an idempotency key derived from the execution, node, run and item, so a retried step reuses the same job instead of creating (and charging for) a second one.
  - Optional **Wait for Completion**: poll until the job is done and return its result. It holds the execution open, so it's best for short jobs. For long jobs use the trigger below. Configure **Poll Interval (Seconds)** and **Max Wait (Seconds)**.
- **Get**: retrieve a job with its status and result.
  - **Job** is a resource locator: pick from your recent jobs, paste an ID, or paste a dashboard link (`https://app.rendobar.com/jobs/...`) and the node extracts the ID. All three modes accept expressions.
  - Optional **Download Output File**: fetch the headline result file (`file.url`) onto the item so the next node can use it directly. The download is streamed to n8n's binary store rather than buffered, so a multi-gigabyte result does not have to fit in memory. Applies only to finished jobs that produced a file.
- **Get Many**: retrieve a list of jobs, newest first. Set **Return All** to page through every match, or leave it off and set a **Limit**. **Filters** narrows by status, job type, originating client and creation date. **Sort** orders by creation time, duration or cost, ascending or descending.
- **Cancel**: stop a job that has not finished yet.
  - Cancel returns the job itself with `status: "cancelled"`, not `{ deleted: true }`. Cancelling is not a delete: the job stays fetchable, keeps its cost and timings, and is removed only when its retention window passes.

#### Resource: File

- **Upload**: send a file from a previous node to Rendobar and get back a URL to use as a job input. Files are ephemeral and auto-delete after 24 hours. Pair it with Job > Create: upload, then reference the returned `url` in the next node's inputs.
  - The file is read a chunk at a time and sent straight to storage, so peak memory stays at one upload part (100 MB) no matter how large the file is. On an n8n running in filesystem or S3 binary mode the file is never loaded into the process at all.

#### Output

Both resources take an **Output** parameter, because a raw job carries around 33 top-level fields and a raw uploaded file carries 21.

- **Simplified** (default): the fields workflows branch on. This is what most workflows and every AI agent should use.
  - Job: `id`, `type`, `status`, `cost`, `createdAt`, `completedAt`, plus either the result (`data`, `file`, `files`, `expiresAt`) or, for a job that stopped, `error`. Never more than ten fields on one item.
  - File: `id`, `url`, `filename`, `contentType`, `mediaType`, `sizeBytes`, `status`, `expiresAt`, `createdAt`.
- **Raw**: every field the API returns.
- **Selected Fields**: only the fields you pick. The ID is always included, whether or not you picked it, so an agent can come back for the rest of the record later.

### Job result (the same shape for every job type)

When a job completes, the node lifts the unified output onto the item so downstream nodes get clean, predictable fields regardless of job type:

- `data`: the job-type-specific computed result (a probe report, a transcript, and so on). `null` for jobs that only produce files.
- `file`: the headline result, either a single output file or a stream manifest (`.m3u8` / `.mpd`). `null` for data-only jobs and pure file sets. Each file is `{ url, path, type, size, meta? }`, where `type` is one of `video`, `image`, `audio`, `captions`, `playlist`, `data`, or `other`.
- `files`: every produced file, the complete list. `[]` for data-only jobs. Use this for jobs that emit a set or a stream.
- `expiresAt`: Unix ms when the file URLs expire, or `null` when the job produced no files.

Set **Output** to **Raw** when you also need `output`, `steps`, `region`, timings, or any other job field.

### Rendobar Trigger

Starts a workflow when a Rendobar event fires. Select the events to listen for (job completed, failed, cancelled, created, started, and balance events). On activation the node registers its webhook URL with Rendobar and removes it on deactivation.

> Rendobar must be able to reach the webhook URL over HTTPS. This works on n8n Cloud or a tunnelled / publicly hosted instance. A plain `localhost` n8n is not reachable from the API, so use `n8n start --tunnel` to test locally.

## When something goes wrong

Every operation reports a stop the same way, so one error path handles the whole node.

Turn on **Settings > Continue On Fail** (or connect the node's error output) and the item you get carries structured fields instead of one opaque string:

| Field | Meaning |
| --- | --- |
| `error` | The message n8n would have shown. |
| `code` | Machine-readable code, for example `INSUFFICIENT_CREDITS`, `RUNNER_TIMEOUT`, `PROCESSING_FAILED`. |
| `retryable` | `true` when running the same step again may succeed. |
| `failedPhase` | `preparing`, `processing` or `finalizing`, when a job reported one. |
| `httpStatus` | The HTTP status, when the call reached Rendobar. |
| `jobId` | The job concerned, when there is one. |
| `description` | How to get unstuck. |

That makes an If or a Switch node enough to split retryable stalls from configuration you have to fix:

```
{{ $json.retryable }}            → route to a Wait node and try again
{{ $json.code === 'INSUFFICIENT_CREDITS' }} → route to an alert
```

A job that Rendobar finished in the `failed` state carries the same information in `error` on the item itself, so **Get** can inspect a stopped job without the workflow stopping.

### Timeouts and retries

- Every request has a 30-second timeout; file transfers get ten minutes.
- Throttled requests (HTTP 429) are always retried, because a throttled request never ran. Stalled ones (500, 502, 503, 504) and dropped connections are retried only where repeating cannot duplicate anything — every read, and the writes that carry an idempotency key or settle to the same state twice. Creating a job is retried, because its idempotency key means a second attempt lands on the first job rather than a new one; registering a webhook endpoint is not.
- Up to two retries, with exponential backoff plus jitter, honouring `Retry-After` in either form HTTP allows.

## Example workflows

Import either JSON below with **Workflows > Import from File / Clipboard**, then pick your Rendobar credential on the Rendobar nodes.

### 1. Compress a video and wait for the result

Manual trigger, one FFmpeg job, blocking until it finishes. Good for clips of a few seconds to a few minutes.

```json
{
	"name": "Rendobar: compress a video",
	"nodes": [
		{
			"parameters": {},
			"id": "6f1b2a4c-0f2a-4f4a-9a1e-6a1f0c2d3e40",
			"name": "When clicking 'Execute workflow'",
			"type": "n8n-nodes-base.manualTrigger",
			"typeVersion": 1,
			"position": [0, 0]
		},
		{
			"parameters": {
				"resource": "job",
				"operation": "create",
				"jobType": {
					"__rl": true,
					"mode": "id",
					"value": "ffmpeg"
				},
				"inputs": "{\n  \"source\": \"https://cdn.rendobar.com/assets/examples/sample.mp4\"\n}",
				"params": {
					"mappingMode": "defineBelow",
					"value": {
						"command": "-i source -vf scale=-2:720 -c:v libx264 -crf 28 -preset fast output.mp4"
					}
				},
				"waitForCompletion": true,
				"maxWait": 600,
				"output": "simplified"
			},
			"id": "1c7f5b60-6b3b-4a2f-b3f2-1a5d2c9e7b81",
			"name": "Compress video",
			"type": "@rendobar/n8n-nodes-rendobar.rendobar",
			"typeVersion": 1,
			"position": [220, 0]
		}
	],
	"connections": {
		"When clicking 'Execute workflow'": {
			"main": [[{ "node": "Compress video", "type": "main", "index": 0 }]]
		}
	}
}
```

The item that comes out carries `file.url`, ready to hand to an upload node, an email node, or an HTTP Request.

### 2. Event-driven: react when any job completes

No polling and no blocked execution. Use this shape for long jobs: submit in one workflow, handle the result in another.

```json
{
	"name": "Rendobar: handle finished jobs",
	"nodes": [
		{
			"parameters": {
				"events": ["job.completed", "job.failed"]
			},
			"id": "8a3d1e52-7c44-4d9c-9c0a-2b6e5f1d4a33",
			"name": "Rendobar Trigger",
			"type": "@rendobar/n8n-nodes-rendobar.rendobarTrigger",
			"typeVersion": 1,
			"position": [0, 0],
			"webhookId": "b0d9d4a1-6b7f-4e0b-9d2a-3c8f5e7a1b22"
		},
		{
			"parameters": {
				"resource": "job",
				"operation": "get",
				"jobId": {
					"__rl": true,
					"mode": "id",
					"value": "={{ $json.data.jobId }}"
				},
				"downloadOutput": true,
				"outputBinaryProperty": "data",
				"output": "simplified"
			},
			"id": "3e5c9b17-2a8d-4f61-8f7d-9c1b0a4e6d55",
			"name": "Fetch job and download file",
			"type": "@rendobar/n8n-nodes-rendobar.rendobar",
			"typeVersion": 1,
			"position": [220, 0]
		}
	],
	"connections": {
		"Rendobar Trigger": {
			"main": [[{ "node": "Fetch job and download file", "type": "main", "index": 0 }]]
		}
	}
}
```

### 3. Upload a local file, then process it

Chain **File > Upload** into **Job > Create**: the upload returns an asset with a `url`, and the job references it as an input.

1. A node that produces binary data (Read/Write Files from Disk, HTTP Request, Google Drive, and so on).
2. **Rendobar**, Resource **File**, Operation **Upload**, Input Binary Field `data`.
3. **Rendobar**, Resource **Job**, Operation **Create**, Job Type of your choice, with Inputs (JSON) set to an expression:

```
{{ JSON.stringify({ source: $json.url }) }}
```

## Compatibility

Tested against n8n's current community-node API (`n8nNodesApiVersion: 1`).

## Troubleshooting

- **The trigger will not activate.** Rendobar has to reach your n8n webhook URL over public HTTPS. On a local instance, start n8n with `--tunnel`.
- **Create Job returns a job you did not just submit.** Idempotency keys are unique per execution, node, run and item. If you are replaying the exact same execution, that is the intended behaviour: the API returns the original job rather than charging you twice.
- **Wait for Completion runs out of time.** The item reports that the job is still running. Raise **Max Wait (Seconds)**, or switch to the Rendobar Trigger, which does not hold the execution open.
- **A field you need is missing from the item.** Set **Output** to **Raw**, or to **Selected Fields** and pick it.
- **A job stopped and you want to know why.** With the default **Simplified** output, a stopped job carries `error.code`, `error.message`, `error.detail`, `error.retryable` and `error.failedPhase`.
- **The Job list is empty.** It shows your recent jobs from `GET /jobs`. A brand new account has none yet — switch the locator to **By ID** or **By URL**.

## Resources

- [Rendobar docs](https://rendobar.com/docs)
- [n8n community nodes](https://docs.n8n.io/integrations/community-nodes/)
- [Changelog](https://github.com/rendobar/n8n-nodes-rendobar/blob/main/CHANGELOG.md)

## License

[MIT](LICENSE.md)
