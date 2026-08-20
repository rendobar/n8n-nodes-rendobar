# @rendobar/n8n-nodes-rendobar

n8n community node for [Rendobar](https://rendobar.com), a media processing API. Submit, track, download and cancel video jobs from your workflows, read the account balance, and start workflows when jobs finish.

[n8n](https://n8n.io) is a fair-code workflow automation platform.

## Contents

- [Installation](#installation)
- [Credentials](#credentials)
- [Nodes](#nodes)
- [Job result](#job-result-the-same-shape-for-every-job-type)
- [Using it as an AI agent tool](#using-it-as-an-ai-agent-tool)
- [Long jobs](#long-jobs-a-callback-and-a-wait-node)
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
  - Each submission carries an idempotency key. Rendobar keeps one job per key, so a repeat under a key it has already seen comes back as the original job instead of creating (and charging for) a second one. Left empty, **Idempotency Key** is derived from the execution, the node, the run, the item and the values being submitted. Set it to tie a job to something of your own that outlives an execution, such as an order number, and give every distinct submission its own value. See [Retrying a submission](#retrying-a-submission) for what happens when a key is spent.
  - **Specify Parameters** chooses between the generated form and **Parameters (JSON)**, where you write the whole parameter object yourself. Three of the nine live job types describe their parameters as a choice between shapes rather than one flat list, so the form has nothing to render for them: `compose`, `image.generate` and `image.edit` need the JSON editor. So does any job type added after this node was built whose schema does the same.
  - A parameter the job type gives a default for arrives filled in with it, and one it does not gives you an empty box — except a number, which n8n cannot draw empty: it puts a `0` in the moment the box appears. Those wait under **Add parameter to send** instead, so nothing is sent for one until you ask for it. What the form shows is what gets sent, `0` included.
  - Optional **Wait for Completion**: poll until the job is done and return its result. It holds the execution open, so it suits jobs of a few minutes. Configure **Poll Interval (Seconds)** and **Max Wait (Seconds)**.
  - Optional **Callback URL** and **Callback Headers**: have Rendobar post the finished job somewhere instead of waiting for it. Paired with a Wait node this is how a job running for hours is handled. See [Long jobs](#long-jobs-a-callback-and-a-wait-node).
  - The two are alternatives, not a pair. Setting **Callback URL** while **Wait for Completion** is on is refused before the job is submitted, because a call that arrives while this node is still polling cannot be answered and is not retried long enough to survive the wait.
- **Get**: retrieve a job with its status and result.
  - **Job** is a resource locator: pick from your recent jobs, paste an ID, or paste a dashboard link (`https://app.rendobar.com/jobs/...`) and the node extracts the ID. All three modes accept expressions.
  - Optional **Download Output File**: fetch the headline result file (`file.url`) onto the item so the next node can use it directly. The download is streamed to n8n's binary store rather than buffered, so a multi-gigabyte result does not have to fit in memory. Applies only to finished jobs that produced a file.
- **Download Output**: fetch the file a finished job produced onto the item, ready for the next node.
  - The same streamed download **Get** offers as a switch, promoted to an operation of its own, because an operation list is where people look for a verb. Pick the job the same three ways, name the field to put the file in, and the item comes back carrying the job with the file beside it.
  - There is one download path in the node and both routes use it, so a job whose link has expired or whose storage stalls reports the same two things either way, and neither leaves a socket open.
  - **It refuses a job with no file instead of handing back an empty item.** Three states mean no file: the job has not finished yet, the job type computes data rather than a file (`ffprobe` and anything else whose result is a report), or the retention window has passed and the files are gone. The stop names the job, lists those three, and is marked retryable only while the job is still on its way to a result. On **Get** the switch stays silent in the same situation, which is right there: the job is what you asked for and the file was an extra.
- **Get Logs**: retrieve what the runner recorded while the job ran. This is the operation to reach for after **Job Failed** on the trigger.
  - One item per job, carrying `jobId`, `status` and `logs`. Each entry in `logs` is `{ timestamp, level, event, message }` plus `step`, `durationMs` and `meta` where the runner set them. `level` is `info`, `warn`, `error` or `debug`, and `event` is one of `job.start`, `step.start`, `step.progress`, `step.complete`, `step.error`, `detail`, `job.complete` or `job.error`. The whole log arrives on one item rather than fanned out, so `{{ $json.logs.map(l => l.message).join('
') }}` is enough to put it in a message.
  - **A job with no logs comes back with `logs: []` and does not stop the workflow.** Logs exist once a runner has reported them, so a job still waiting or running has none yet, a job that never reached a runner never will, and a job whose retention window has passed had its logs swept along with its files. That last case is why the field is `logs` and not a promise: `status` on the same item is what tells the three apart.
  - The node reads the job before the logs. `GET /jobs/{id}/logs` answers 404 both for a job that does not exist and for a job with no logs, and the only difference is the sentence in the body, so a job ID nobody meant to type stops the item with the message that fits rather than reading as an empty log.
- **Get Many**: retrieve a list of jobs, newest first. Set **Return All** to page through every match, or leave it off and set a **Limit**. **Filters** narrows by status, job type, originating client and creation date. **Sort** orders by creation time, duration or cost, ascending or descending.
  - **Return All is not a consistent snapshot.** It reads pages one after another by offset, over an ordering — creation time — with no tiebreaker under it, and jobs submitted together really do share a millisecond. Two page queries are free to order those rows differently, and a job created while the paging runs pushes every row behind it one slot along. Either can put one job in two pages and another in none. The node de-duplicates on job ID across pages, so you never get the same job twice; a job that slipped the other way, out of the window between two requests, is not recoverable from here and will be missing. Set **Created Before** under **Filters** to the moment the run starts when the list has to be exact — that freezes the set against anything submitted while it walks.
- **Cancel**: stop a job that has not finished yet.
  - Cancel returns the job itself with `status: "cancelled"`, not `{ deleted: true }`. Cancelling is not a delete: the job stays fetchable, keeps its cost and timings, and is removed only when its retention window passes.

#### Resource: Account

- **Get**: read the credit balance, the plan limits and the spend so far this period.
  - This is what **Balance Low** and **Balance Depleted** on the trigger could not tell you by themselves. A workflow woken by one can now ask how low, and any workflow can check the balance before submitting something expensive.
  - The item is `GET /billing/state` as it stands: `balance.amount` in dollars, `plan` with its `slug`, `name`, `price` and the four limits a submission is measured against (`concurrentJobs`, `apiRequestsPerMinute`, `maxJobTimeout` in seconds, `maxInputFileSize` in bytes), `subscription` or `null`, `usage.currentPeriodSpend` in dollars with `usage.jobCount`, `isPro`, `creditBonusRate`, and `upgradePlan` or `null` when there is no plan above this one.
  - **There is no Output parameter on this resource.** Seven top-level fields, none of them describing how Rendobar is built, is not a payload with anything to trim. The three-mode selector exists because a raw job carries around 33 fields and a raw file 21.
  - **There is no Usage operation, on purpose.** `GET /billing/usage` carries no balance at all, so it does not answer the question the balance events raise. What it does carry is a per-job-type map and one row per date and job type, growing with the account's history. That is a chart rather than something a workflow branches on, and `usage.currentPeriodSpend` above is already the spend figure worth acting on. **Custom API Call** reaches it for anyone who wants the breakdown.

#### Resource: File

- **Upload**: send a file from a previous node to Rendobar and get back a URL to use as a job input. Files are ephemeral and auto-delete after 24 hours. Pair it with Job > Create: upload, then reference the returned `url` in the next node's inputs.
  - The file is read a chunk at a time and sent straight to storage, so peak memory stays at one upload part (100 MB) no matter how large the file is. On an n8n running in filesystem or S3 binary mode the file is never loaded into the process at all.

#### Anything else in the API

The node models jobs, files and the account. Everything else the API exposes (usage breakdowns, share links, webhook deliveries, team and organization management) is reached with **Custom API Call**, which n8n adds to the **Resource** and **Operation** dropdowns by itself because the Rendobar credential carries its own authentication. Choosing it points you at the HTTP Request node with the credential already applied, so you can call any endpoint without handling a key. That is why this package ships no Custom API Call operation of its own: a hand-written one would be a second and worse route to the same place.

#### Output

The **Job** and **File** resources take an **Output** parameter, because a raw job carries around 33 top-level fields and a raw uploaded file carries 21.

- **Simplified** (default): the fields workflows branch on. This is what most workflows and every AI agent should use.
  - Job: `id`, `type`, `status`, `cost`, `createdAt`, `completedAt`, plus either the result (`data`, `file`, `files`, `expiresAt`) or, for a job that stopped, `error`. Never more than ten fields on one item.
  - File: `id`, `url`, `filename`, `contentType`, `mediaType`, `sizeBytes`, `status`, `expiresAt`, `createdAt`.
- **Raw**: every field the API returns.
- **Selected Fields**: only the fields you pick. The ID is always included, whether or not you picked it, so an agent can come back for the rest of the record later.

Neither **Get Logs** nor the **Account** resource takes one. **Get Logs** emits log entries rather than a job, so both the projection and the field list beneath it would describe the wrong record, and the parameter is hidden on that operation. The Account item carries seven top-level fields, which is not a payload with anything to trim.

### Job result (the same shape for every job type)

When a job completes, the node lifts the unified output onto the item so downstream nodes get clean, predictable fields regardless of job type:

- `data`: the job-type-specific computed result (a probe report, a transcript, and so on). `null` for jobs that only produce files.
- `file`: the headline result, either a single output file or a stream manifest (`.m3u8` / `.mpd`). `null` for data-only jobs and pure file sets. Each file is `{ url, path, type, size, meta? }`, where `type` is one of `video`, `image`, `audio`, `captions`, `playlist`, `data`, or `other`.
- `files`: every produced file, the complete list. `[]` for data-only jobs. Use this for jobs that emit a set or a stream.
- `expiresAt`: Unix ms when the file URLs expire, or `null` when the job produced no files.

Set **Output** to **Raw** when you also need `output`, `steps`, `region`, timings, or any other job field.

### Rendobar Trigger

Starts a workflow when a Rendobar media job completes, stops or is cancelled, or when the account balance runs low. Select the events to listen for: **Job Created**, **Job Started**, **Job Completed**, **Job Failed**, **Job Cancelled**, **Balance Low** and **Balance Depleted**. On activation the node registers its webhook URL with Rendobar and removes it on deactivation.

Pair **Job Failed** with **Job > Get Logs** to see what the runner reported, and **Balance Low** with **Account > Get** to find out how low.

> Rendobar must be able to reach the webhook URL over HTTPS. This works on n8n Cloud or a tunnelled / publicly hosted instance. A plain `localhost` n8n is not reachable from the API, so use `n8n start --tunnel` to test locally.

## Using it as an AI agent tool

The action node is available to an AI Agent, so an agent can submit and track media
jobs on its own. Connect it to the agent's **Tool** port and the agent chooses the
job type and the parameters.

Two things make this work in practice.

**The agent sees your current capabilities, not a snapshot.** The job type list comes
from `GET /jobs/types` on your account and each type's parameters come from its
schema, both read at the moment the agent looks. A job type added to Rendobar after
this node was published is available to the agent with no upgrade.

**Keep the output small.** Set **Output** to `Simplified`, the default, which returns
ten fields. A raw job carries around thirty-three, most of them irrelevant to a
decision and all of them consuming the agent's context. Use `Selected Fields` if you
want fewer still. The job ID is always included, so the agent can follow up with
**Get**.

A worked example: give an agent this node and ask it to report the resolution and
duration of a video. It submits an `ffprobe` job with the file URL, waits for the
result, and reads the answer out of `data`. Nothing about the request is written into
the node in advance.

Each tool call is submitted under its own idempotency key, so an agent making several
calls in one conversation gets a separate job for each. See
[Retrying a submission](#retrying-a-submission).

## Long jobs: a callback and a Wait node

Jobs run up to an hour on Free and nine hours on Pro. **Wait for Completion** cannot cover that. It holds the execution open and occupies a worker for the whole run, and the cap you set is a cap you have to guess.

**Callback URL** is the way through, and it is n8n's own pattern for a slow third-party API. Put a **Wait** node after **Job > Create**, set the Wait node to resume **On Webhook Call**, and set Callback URL to an expression:

```
{{ $execution.resumeUrl }}
```

Rendobar posts the finished job to that address, n8n picks the execution back up, and nothing is held open in between. `$execution.resumeUrl` resolves on any node, including the one that runs before the Wait node, so the Create node can hand it over at submit time.

**Leave Wait for Completion off.** The two are alternatives, and together they lose the callback every time: Rendobar calls the instant the job ends, the execution is still inside the Create node's poll loop, n8n answers 409 because the execution is `running` rather than parked, and the five delivery retries run out before the poll returns. The execution then reaches the Wait node with nothing left to arrive. The node refuses the combination before submitting anything, naming both parameters, so it costs you a run rather than a job.

Five things decide whether this works:

1. **Set the Wait node's HTTP Method to POST.** It defaults to GET, and a resume address called with a method it does not expect answers 404 without saying why. This is the setting that most often makes the recipe quietly do nothing.
2. **Read the job from `$json.body`.** n8n wraps a resume call as `{ headers, params, query, body }`, so the ID is at `{{ $json.body.data.jobId }}` and not at `{{ $json.data.jobId }}`.
3. **Fetch the job again rather than trusting what arrived.** Feed that ID into a Rendobar **Get**, and you get fresh download links, the node's usual output shape, and data that came over your own authenticated connection.
4. **One job per execution.** A resume call continues the whole execution once, so a Create node that submitted five jobs continues on whichever finishes first and loses the other four. Put the submit-and-wait pair in a sub-workflow and call it once per item.
5. **Switch on the Wait node's Limit Wait Time.** A Wait node set to resume on a webhook call has no ceiling by default, and Rendobar gives up on an undeliverable call after about five minutes (see [What Rendobar sends, and when](#what-rendobar-sends-and-when)). If the call never lands — n8n was restarted or redeployed, the tunnel dropped, the receiver answered non-2xx five times — the execution stays parked with nothing left to wake it. **Limit Wait Time** is what gives it a way out: set **Limit Type** to **After Time Interval** and the **Amount** to something past your longest job plus the delivery window, then branch on the resumed item to tell a timeout from a real callback. Nine hours is the platform ceiling on Pro, one hour on Free.

### Authenticating the callback

The resume address is a capability. Anyone holding it can continue the execution, so treat it the way you would treat a key.

Recent n8n versions append a random `signature` token to the address and check it before resuming. Older ones do not, and an n8n execution ID is a sequential integer, so on those the address is guessable by anyone who can reach your instance.

For a second layer, set the Wait node's **Authentication** to **Header Auth**, give it a header name and value, and add the same pair under **Callback Headers**. Rendobar sends them with the call and n8n checks them before resuming.

Rendobar can also sign a callback with an HMAC in `X-Rendobar-Signature`, and this node deliberately does not offer that. The call lands on n8n's own resume endpoint rather than on any node, so nothing in the workflow is in a position to check a signature, and a switch that implied otherwise would be worse than none. Header Auth is the equivalent n8n can actually enforce, and step 3 above means the payload never has to be trusted in the first place.

### What Rendobar sends, and when

- The call fires on every ending, whether the job completed, stopped or was cancelled, and that cannot be turned off. There is no ending that sends nothing.
- The body is the same envelope the trigger node delivers: `{ version, event, deliveryId, timestamp, orgId, data }`.
- **Delivery is best effort, not a guarantee.** A call not answered with a 2xx is retried five times with backoff, over roughly the next two and a half to five minutes, and then given up on. That window is also what covers the gap between a job finishing and n8n arriving at the Wait node, which n8n answers with a 409 until it gets there. Nothing arrives after the window closes, and n8n's Wait node has no timeout of its own unless you set one — so **set the Wait node's Limit Wait Time**, per step 5 above. Anything that keeps n8n from answering for more than about five minutes closes the window for good: a restart or a deploy, a tunnel that drops, a receiver that answers non-2xx five times, or simply an execution that takes longer than that to reach the Wait node.
- Delivery is over public HTTPS. A `localhost` n8n is not reachable from Rendobar, so run `n8n start --tunnel` or put the instance behind a public address. The node checks the address before submitting the job and tells you if it cannot be reached.
- Headers whose name begins with `X-Rendobar-` are kept for Rendobar's own delivery details and are refused.
- Rendobar can also send a ping when a job starts running. This node does not offer it, because on a resume address it would continue the execution while the job is still going, which is the one thing the recipe exists to avoid.

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
{{ $json.retryable }}            → route to a Wait node, then back into this node
{{ $json.code === 'INSUFFICIENT_CREDITS' }} → route to an alert
```

A job that Rendobar finished in the `failed` state carries the same information in `error` on the item itself, so **Get** can inspect a stopped job without the workflow stopping.

### Retrying a submission

An idempotency key is bound to one job for good. Once that job has stopped without producing anything, Rendobar will not attach a second job to the key and will not hand the dead one back either: it answers `CONFLICT`, naming the job the key holds. So a resubmission only goes through if something moves it onto a different key.

- **Routing `retryable` into a Wait node and back into this node works.** A second pass of the same node is a new run, and the run is one of the things the node builds its key from, so the resubmission is a genuinely fresh one.
- **Routing it into a second Rendobar node works** for the same reason — the node is part of the key.
- **Running the workflow again works.** A new execution has a new ID.
- **n8n's own Settings > Retry On Fail works, but only because the node handles it.** n8n gives a node no way to tell which try it is on: the node is re-run inside the same execution with everything it can read unchanged, so the key it builds comes out identical. When Rendobar reports that key spent, the node moves the submission onto a fresh one derived from the job the old key holds, and keeps doing so within the node's own **Max Tries**.
- **A key you set in Idempotency Key is left exactly as you wrote it.** It is a statement about which submissions are the same submission, and only its author knows what changing it would mean, so a spent one is reported rather than quietly varied. Make it differ between attempts — ending it in `{{ $runIndex }}` is usually enough — if you want deliberate retries under your own key.

None of this duplicates work. Rendobar refuses a key only once the job holding it has stopped before reaching a runner, so there is no result to lose and nothing to hand back.

### Timeouts and retries

- Every request has a 30-second timeout; file transfers get ten minutes.
- Throttled requests (HTTP 429) are always retried, because a throttled request never ran. Stalled ones (500, 502, 503, 504) and dropped connections are retried only where repeating cannot duplicate anything — every read, and the writes that carry an idempotency key or settle to the same state twice. Creating a job is retried, because its idempotency key means a second attempt lands on the first job rather than a new one; registering a webhook endpoint is not.
- Up to two retries, with exponential backoff plus jitter, honouring `Retry-After` in either form HTTP allows.

## Example workflows

Import any of the JSON below with **Workflows > Import from File / Clipboard**, then pick your Rendobar credential on the Rendobar nodes.

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
				"options": {
					"waitForCompletion": true,
					"maxWait": 600
				},
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

### 4. A long job, with no worker held open

The pattern from [Long jobs](#long-jobs-a-callback-and-a-wait-node), end to end. The Create node submits and returns straight away, the Wait node parks the execution, and Rendobar's call brings it back. The Wait node is already set to **POST**, which is not its default, and its **Limit Wait Time** is on at ten hours — past the nine-hour platform ceiling — so an execution whose callback never lands releases itself instead of parking for good. **Wait for Completion** is off, and has to be.

It also shows **Parameters (JSON)**: `image.generate` offers a choice of parameter shapes, so the generated form has nothing to render and the JSON editor is the way to configure it.

```json
{
	"name": "Rendobar: generate an image without holding the execution",
	"nodes": [
		{
			"parameters": {},
			"id": "0a4c8f21-3d55-4a0e-9b6c-77e2f1a9c004",
			"name": "When clicking 'Execute workflow'",
			"type": "n8n-nodes-base.manualTrigger",
			"typeVersion": 1,
			"position": [
				0,
				0
			]
		},
		{
			"parameters": {
				"resource": "job",
				"operation": "create",
				"jobType": {
					"__rl": true,
					"mode": "id",
					"value": "image.generate"
				},
				"inputs": "{}",
				"paramsMode": "json",
				"paramsJson": "{\n  \"model\": \"standard\",\n  \"prompt\": \"a cutaway diagram of a espresso machine, technical illustration\",\n  \"width\": 1024,\n  \"height\": 1024\n}",
				"options": {
					"callbackUrl": "={{ $execution.resumeUrl }}"
				},
				"output": "simplified"
			},
			"id": "5b8e2d10-9c31-42f7-8a4d-6e0b3c7f1d92",
			"name": "Generate image",
			"type": "@rendobar/n8n-nodes-rendobar.rendobar",
			"typeVersion": 1,
			"position": [
				220,
				0
			]
		},
		{
			"parameters": {
				"resume": "webhook",
				"httpMethod": "POST",
				"limitWaitTime": true,
				"limitType": "afterTimeInterval",
				"resumeAmount": 10,
				"resumeUnit": "hours",
				"options": {}
			},
			"id": "c2f7a940-1b6e-4d83-9f05-8a1c4e6b2d37",
			"name": "Wait for the callback",
			"type": "n8n-nodes-base.wait",
			"typeVersion": 1.1,
			"position": [
				440,
				0
			],
			"webhookId": "f4a1c8b2-5d09-4e77-b3a6-9c2e1f0d7a55"
		},
		{
			"parameters": {
				"resource": "job",
				"operation": "get",
				"jobId": {
					"__rl": true,
					"mode": "id",
					"value": "={{ $json.body.data.jobId }}"
				},
				"downloadOutput": true,
				"outputBinaryProperty": "data",
				"output": "simplified"
			},
			"id": "9d3b6e58-4a72-4c11-85fe-2b7d0a9c3e61",
			"name": "Fetch job and download file",
			"type": "@rendobar/n8n-nodes-rendobar.rendobar",
			"typeVersion": 1,
			"position": [
				660,
				0
			]
		}
	],
	"connections": {
		"When clicking 'Execute workflow'": {
			"main": [
				[
					{
						"node": "Generate image",
						"type": "main",
						"index": 0
					}
				]
			]
		},
		"Generate image": {
			"main": [
				[
					{
						"node": "Wait for the callback",
						"type": "main",
						"index": 0
					}
				]
			]
		},
		"Wait for the callback": {
			"main": [
				[
					{
						"node": "Fetch job and download file",
						"type": "main",
						"index": 0
					}
				]
			]
		}
	}
}
```

The Get node re-fetches over your authenticated connection, so the download link is fresh and the payload that arrived never has to be trusted.

### 5. React when a job stops, and read what the runner reported

**Job Failed** on the trigger and **Job > Get Logs** are the pair this exists for. The item that arrives carries `jobId`, `status` and `logs`, so a Slack or an email node can post the log straight from `{{ $json.logs.map(l => l.message).join('
') }}`.

A job that stopped before a runner ever saw it has no logs to give, and that arrives as `logs: []` rather than stopping the workflow. Branch on `{{ $json.logs.length }}` when you want to tell the two apart, and read `error` from a **Get** on the same job for the reason a job with no logs stopped.

```json
{
	"name": "Rendobar: read the logs of a job that stopped",
	"nodes": [
		{
			"parameters": {
				"events": ["job.failed"]
			},
			"id": "2f7c1a05-8e34-4b19-9d6a-4c0e7b3f1a28",
			"name": "Rendobar Trigger",
			"type": "@rendobar/n8n-nodes-rendobar.rendobarTrigger",
			"typeVersion": 1,
			"position": [0, 0],
			"webhookId": "6c5e9a13-2d78-4f40-b1c9-8e3a7d0f6b41"
		},
		{
			"parameters": {
				"resource": "job",
				"operation": "getLogs",
				"jobId": {
					"__rl": true,
					"mode": "id",
					"value": "={{ $json.data.jobId }}"
				}
			},
			"id": "b41d8e70-5a92-4c3f-8e17-0d6b2a9f5c34",
			"name": "Get logs",
			"type": "@rendobar/n8n-nodes-rendobar.rendobar",
			"typeVersion": 1,
			"position": [220, 0]
		}
	],
	"connections": {
		"Rendobar Trigger": {
			"main": [[{ "node": "Get logs", "type": "main", "index": 0 }]]
		}
	}
}
```

### 6. Check the balance before spending it

**Balance Low** and **Balance Depleted** on the trigger say that something has happened, and **Account > Get** is what says how much. The same operation in front of a submission is a pre-flight: read it, compare `balance.amount` against what the job will cost, and route around it rather than collecting an `INSUFFICIENT_CREDITS` stop.

1. **Rendobar Trigger** with **Balance Low** selected, or any trigger of your own.
2. **Rendobar**, Resource **Account**, Operation **Get**.
3. An **If** node on `{{ $json.balance.amount < 5 }}`, into whatever you want told.

`plan.limits` on the same item is what a submission is measured against, so `maxInputFileSize` and `maxJobTimeout` are there too when the check is about size or length rather than money.

## Compatibility

Tested against n8n's current community-node API (`n8nNodesApiVersion: 1`).

## Troubleshooting

- **The trigger will not activate.** Rendobar has to reach your n8n webhook URL over public HTTPS. On a local instance, start n8n with `--tunnel`.
- **Create Job returns a job you did not just submit.** That is the idempotency key working as intended: a submission Rendobar has already seen under the same key comes back as the original rather than being charged for twice. It happens when the same item of the same execution reaches the same node again, and when **Idempotency Key** is set to a value another submission already used. Give each distinct submission its own value.
- **Create Job says the idempotency key is already taken.** The key is bound to a job that stopped before producing anything, and Rendobar will not attach a second job to it. When the node chose the key it moves off it by itself; a key you set by hand is reported instead, naming the job it holds so you can open it with **Get**. Change the value — ending it in `{{ $runIndex }}` is usually enough — then run the workflow again. See [Retrying a submission](#retrying-a-submission).
- **Wait for Completion runs out of time.** The item reports that the job is still running. Raise **Max Wait (Seconds)**, or move to [Callback URL with a Wait node](#long-jobs-a-callback-and-a-wait-node), which holds nothing open and has no cap to raise.
- **The workflow never continues past the Wait node.** In order of how often it is the cause: the Wait node's **HTTP Method** is still GET and Rendobar posts; Rendobar cannot reach the address, so a local n8n needs `n8n start --tunnel`; the Create node submitted several jobs into one execution, and the first one back consumed the single resume; or the call was made while n8n could not answer it and the five delivery retries ran out — a restart, a deploy, a dropped tunnel, or a receiver that answered non-2xx. Nothing arrives after that window, so switch on the Wait node's **Limit Wait Time** to give every parked execution a way out. (**Wait for Completion** left on beside **Callback URL** used to be the fourth cause. The node now refuses that combination before submitting the job.)
- **A parked execution has to be released by hand.** Open it under **Executions**, and stop it. Then set the Wait node's **Limit Wait Time** so the next one releases itself.
- **The Parameters panel is empty.** `compose`, `image.generate` and `image.edit` describe their parameters as a choice between shapes, which the generated form cannot render. Set **Specify Parameters** to **Using JSON** and write them in **Parameters (JSON)**; the panel says so too.
- **A number parameter is not on the form.** Optional numbers the job type gives no default for start under **Add parameter to send**. n8n puts a `0` into an empty number box as soon as it draws one and then sends that `0` as though you had chosen it, which Rendobar refuses for `Timeout` and accepts for `Seed` — so the box is offered rather than drawn. Add the parameter and it behaves like any other; leave it alone and Rendobar applies its own default. A node saved before this changed keeps its `0` on the form: remove the parameter with the bin icon beside it, or pick the job type again.
- **A field you need is missing from the item.** Set **Output** to **Raw**, or to **Selected Fields** and pick it. **Get Logs** and **Account > Get** have no **Output** parameter, so their items are never narrowed.
- **Download Output says the job has no output file.** One of three things. The job has not finished, so wait for it or use **Get** and read `status`. The job type computes data rather than a file, in which case the result is under `data` on a **Get** and there was never a file to fetch. Or the retention window has passed and the files are gone, which means submitting the job again. The stop is marked retryable only in the first case.
- **Get Logs came back with an empty list.** Logs exist once a runner has reported them. A job still waiting or running has none yet, a job that never reached a runner never will, and a job whose retention window has passed had its logs swept with its files. `status` on the same item tells the first apart from the rest. This is deliberately not a stop: reacting to **Job Failed** and asking for the logs is what the operation is for, and a job that stopped before a runner saw it is exactly the job that has none.
- **A job ID that does not exist reports that, rather than reading as an empty log.** The node reads the job before the logs for this reason, because the API answers 404 to both and only the sentence differs.
- **A job stopped and you want to know why.** With the default **Simplified** output, a stopped job carries `error.code`, `error.message`, `error.detail`, `error.retryable` and `error.failedPhase`.
- **The Job list is empty.** It shows your recent jobs from `GET /jobs`. A brand new account has none yet — switch the locator to **By ID** or **By URL**.
- **A Return All came back short.** Paging is by offset over an ordering with no tiebreaker, so a job submitted while it runs can shift a row out of the window before it is read. Set **Created Before** under **Filters** to freeze the set, then run it again.

## Resources

- [Rendobar docs](https://rendobar.com/docs)
- [n8n community nodes](https://docs.n8n.io/integrations/community-nodes/)
- [Changelog](https://github.com/rendobar/n8n-nodes-rendobar/blob/main/CHANGELOG.md)

## License

[MIT](LICENSE.md)
