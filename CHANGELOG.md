# Changelog

## Unreleased

### Fixed

- **The idempotency key collided on every AI-tool call, silently returning the wrong job.** The key was built from execution, node, run and item alone. When the node runs as a tool all four are fixed for the whole agent run, and `POST /jobs` looks a repeated key up on `(org, key)` without ever comparing payloads — so an agent rendering clip A and then clip B got clip A's job back as the answer for B, with B's parameters discarded, billed once, and nothing raised. The key now includes a fingerprint of the submission, which differs between requests and is identical on a retry, so dedupe-on-retry still holds.
- **The run index was read through a method the AI-tool context does not have.** `getExecuteData()` is absent from n8n's supply-data shape, and `?.` guards the result rather than the call, so the tool path was either a hard `TypeError` or a silent zero. It is feature-detected now. `getNextRunIndex()` is deliberately not used as a fallback — see below.
- **A full queue was retried, re-billing work that had already run.** `QUEUE_FULL` answers 429, which the node always retried on the reasoning that a throttled request never ran. That is true of `RATE_LIMITED` but not of `QUEUE_FULL`, which is raised after the compose-assist window has probed every input asset and run a model over them — all billed, and all repeated on each retry. A queue does not drain inside a backoff measured in seconds either. It is now reported as retryable-by-the-user but never retried inline.
- **`Get Many` could read a row twice and end a `Return All` early.** Paging advanced the offset by the number of rows that survived narrowing rather than the number the API sent, so a single non-object row shifted the window and, being a short page, read as the end of the list.
- **`Get Many` could return more rows than `Limit`.** A whole page was pushed before the limit was tested. Pages are trimmed to the remaining budget.
- **A failed download leaked its socket.** With `encoding: 'stream'`, a non-2xx still yields a live stream; it was thrown past without being closed.
- **The upload size guard missed a file longer than declared.** When the declared size divided evenly into parts, every part came back full and the byte count matched exactly while the remainder never shipped. The source is now checked for leftovers.
- **`NOT_CONFIGURED` was reported as retryable**, contradicting its own guidance to contact support. Retryability now honours the code where the code is decisive, not only the HTTP status.
- **The retryable job-code fallback named a code the API never sends.** `DISPATCH_ERROR` is what the API's own set lists, but the dead-letter consumer writes `DISPATCH_EXHAUSTED`, which was missing.
- **`CONFLICT` guidance assumed a job.** The trigger hits the same code when the account is already at its webhook endpoint limit, and was shown job-flavoured advice.
- **`QUEUE_EXPIRED` and `HTTP_ERROR` had no guidance** and fell through to the generic line.
- **An empty `httpCode` was reported as the status `HTTP_0`**, because `Number('')` is `0` and `0` is finite.
- **A date filter that resolved to a number was dropped in silence.** The value was narrowed to a string before parsing, so anything else vanished instead of being used or reported.
- **The credential test did not trim the base URL** the way the node does, so a trailing slash made the Test button fail on a credential that worked at run time.
- **`Max Wait (Seconds)` could overshoot by a whole poll interval**, because the deadline was only tested at the top of the loop.
- **A single-buffer upload was copied for nothing** — `Buffer.concat` on a one-element array, at that point up to 100 MB.
- A `resourceLocator` is no longer asked to extract a value from a plain string, which is what a workflow saved before the parameter became a locator stores.
- **Uploading a large file could exhaust memory, and files over ~2 GB could not be uploaded at all.** The whole file was read into a single `Buffer` before anything was sent, which defeats n8n's filesystem-backed binary mode and hits Node's maximum buffer length well below the 10 GB the Pro plan accepts as job input. The file is now read a chunk at a time and sent straight to storage, so peak memory is one upload part (100 MB) regardless of file size.
- **Downloading an output file buffered the whole thing twice.** `Download Output File` read the response as an `arraybuffer` and then copied it into a `Buffer`. It now streams the response into n8n's binary store.
- **No request had a timeout or a retry.** n8n's HTTP helper has neither by default, so a stalled connection held the execution open and a single 503 lost the item. Every request now carries a 30-second timeout (ten minutes for file transfers) and up to two retries with exponential backoff plus jitter, honouring `Retry-After` in both forms HTTP allows. Throttled requests (429) always retry; stalled ones retry only where repeating cannot duplicate anything.
- **Invalid JSON in `Inputs (JSON)` surfaced as `Unexpected token ... in JSON`.** It now reports which parameter is at fault and what shape it wants.
- **The trigger could go silently dead.** Activation trusted the endpoint ID stored in the workflow, so if the registration had been removed on Rendobar's side — after a failed deactivation, or by hand in the dashboard — n8n skipped re-registering and the workflow never fired again. Activation now verifies the registration, re-registers when it is gone, and repairs a drifted URL or event list in place instead of creating a duplicate.
- **A stopped job told you nothing under the default output.** `Simplified` omitted `error`, so a failed job arrived as a bare `status: "failed"`. `error` is now part of the simplified projection; because a job is either complete or stopped, an item still never carries more than ten fields.
- **The trigger's webhook calls raised raw HTTP errors.** Registration and removal now report what happened and how to get unstuck, like the rest of the node.
- **An upload whose byte count did not match what was declared assembled a truncated file in silence.** Rendobar sizes the transfer from the count sent at init, so a file that read back short or long produced a wrong object with no complaint. The bytes are counted as they go and a mismatch stops the item.
- **`Limit`, `Poll Interval` and `Max Wait` were only bounded in the editor.** `typeOptions.minValue` does not constrain an expression, so a poll interval of zero would spin against the API and a negative limit is read by SQLite as "no limit". The floors are enforced at run time too.
- **`Wait for Completion` gave up silently** when the submission came back without a job ID, handing over an unfinished job as though it had finished. It now says so.
- **The `Fields` dropdowns were sorted by field name, not by the label shown.** The acronym overrides moved several entries out of order (`ETA`, `Org ID`, `Web URL`). They now sort on what the user reads.

### Added

- **A per-job `Callback URL`, which is how a job running for hours is handled.** Jobs run up to an hour on Free and nine on Pro, and `Wait for Completion` cannot reach that: it holds the execution open and occupies a worker for the whole run. `POST /jobs` takes a callback Rendobar posts the finished job to, and that maps onto n8n's own pattern for a slow API. Set `Callback URL` to a Wait node's `{{ $execution.resumeUrl }}` and n8n parks the execution instead of holding it, with per-job correlation by construction and no cap to guess. Rendobar calls on every ending, including a job that stopped or was cancelled, so a parked execution is never left waiting. The address is checked before the job is submitted, because Rendobar delivers over public HTTPS and a `localhost` n8n is not reachable from it. There is a README recipe and an importable example workflow.
- **`Callback Headers`**, sent with the callback so the receiver can tell a genuine call apart from anything else that finds the address. On a Wait node these pair with its own Header Auth. Names beginning with `X-Rendobar-` are refused, since Rendobar puts its delivery details there.
- **`Specify Parameters`, with a `Using JSON` mode.** Parameters came only from the generated form, which is built from the flat field list `GET /jobs/types/:type/schema` projects. Three of the nine live job types describe their parameters as a choice between shapes instead, so that projection is empty for them: `compose` is an `anyOf`, `image.generate` and `image.edit` are `oneOf`. The panel rendered nothing, `params` went out as `{}` and the API refused the job, with no way round it. **The compose lane and the whole generation lane were unreachable from n8n.** `Parameters (JSON)` takes the object directly, and the notice on an empty panel now says which of the two cases it is rather than always claiming the job type takes no parameters.

- **`Job` is a resource locator.** `Get` and `Cancel` now let you pick from your recent jobs, paste an ID, or paste a dashboard link, which the node parses. n8n's UX guidelines ask for a resource locator wherever a single item is selected. **This replaces the plain `Job ID` text field**; a workflow saved with an earlier version keeps executing, but the value has to be re-picked in the editor.
- **Structured failure output.** With `Continue On Fail` on, the item now carries `code`, `retryable`, `failedPhase`, `httpStatus` and `jobId` beside the `error` message, so an If or Switch node can route a retryable stall differently from a configuration slip. Every operation reports the same shape.
- **An `Output` parameter on the File resource**, with the same three modes the Job resource has. An uploaded file's record carries 21 fields, over n8n's ten-field guideline for nodes usable as AI tools. `Simplified` keeps the URL, filename, type, size, status and timings and drops the storage bookkeeping (`orgId`, `createdBy`, `scope`, `kind`, `etag`, `checksum`). **This changes the default output shape of `File > Upload`.** Set `Output` to `Raw` to keep the previous behaviour.
- **A `Sort` collection on `Get Many`**, ordering by creation time, duration or cost, ascending or descending. Placed below `Filters`, per the guidelines.
- **`Created After` and `Created Before` filters** on `Get Many`.
- **A test suite for the verification guidelines themselves** — no file-system or environment access in the build, no runtime dependencies, MIT, English only, masked credential fields — plus tests that the README's example workflows still match the node's parameters.

### Changed

- `Wait for Completion` and the message it raises on running out of time now point at `Callback URL`, which is the answer for a job that long, rather than at the trigger node.

- **The API boundary is parsed rather than asserted.** `shared/transport.ts` previously handed back `any` and every caller cast its way to a shape nothing had checked. Responses are now narrowed through total type guards, leaving a single documented assertion where the untyped value enters.
- Operation copy follows n8n's vocabulary more closely: `Get Many` reads "Retrieve a list of jobs, newest first", `Cancel` reads "Stop a job that has not finished yet".
- Error messages carry the `[item N]` marker, name the parameter at fault in single quotes, and avoid the words the guidelines rule out. Each one now has a description saying how to get unstuck, keyed off the code Rendobar returned.
- The `Job Type` list and the `Fields` dropdowns are sorted alphabetically.
- "binary" no longer appears in parameter descriptions or hints, per n8n's UI guidance; the standard `Input Binary Field` / `Output Binary Field` display names are kept for consistency with n8n's own nodes.
- The credential fields gained placeholders and clearer descriptions.

## 0.3.0

### Fixed

- **The Rendobar Trigger could never activate.** It posted `{ url, events }` to `POST /webhooks/endpoints`, but the API requires `{ name, url, subscribedEvents }`. `name` was missing and `events` was not a schema key, so every activation was rejected with a 400. The node now sends a name derived from the workflow and node name (trimmed to the API's 50-character limit) and the correct `subscribedEvents` key.
- **Idempotency keys could collide and silently return the wrong job.** The key was `n8n:<executionId>:<itemIndex>`, so two Rendobar nodes in one workflow, or two passes of a Loop Over Items, produced the same key. The API treats a repeated key as a hit and returns the first job with no error, so the second node handed back the first node's result. The key now includes the node ID and the run index, and is still stable across a retry of the same step.
- **The trigger no longer stores the webhook signing secret.** n8n's workflow static data is unencrypted and travels in workflow exports, and nothing read the secret back. Deactivating a trigger also clears a secret stored by earlier versions.
- **The build could emit an incomplete `dist/`.** `n8n-node build` deletes `dist/` and then runs `tsc`, but the TypeScript incremental cache survived the delete, so unchanged files were not re-emitted. A local build could produce a package missing `transport.js`, which fails to load in n8n. Incremental compilation is off.

### Added

- **`Get Many` on the Job resource**, over `GET /jobs`. Supports `Return All` with paging, a `Limit`, and filters for status, job type and originating client.
- **A `Resource` selector** (`Job`, `File`). Job operations and the file upload were previously one flat list.
- **An `Output` parameter** on job operations, with `Simplified` (default), `Raw` and `Selected Fields`. A raw job carries around 32 top-level fields, over n8n's ten-field guideline for nodes that are usable as AI tools. **This changes the default output shape.** Set `Output` to `Raw` to keep the previous behaviour.
- **Light and dark icon variants** for the node, the trigger and the credential. The icons are also 95% smaller (4.7 KB each, down from 104 KB).
- **`npm run test`**, which runs lint, build and a unit suite (`node:test`, no extra dependencies). `npm run test:unit` runs the suite alone against `dist/`.
- **An example-workflow section in the README**, plus troubleshooting and a table of contents.

### Changed

- Operation `action` strings dropped their articles (`Cancel a job` is now `Cancel job`), per n8n's UX guidelines.
- The two binary-field placeholders gained the `e.g.` prefix.
- The failed-job error reads `Rendobar could not complete job <id>` and now carries a description telling you how to get unstuck. The wait-timeout error was split the same way.
- `@n8n/node-cli` is pinned to `^0.41.2` instead of `*`.

## 0.2.0

- Send `X-Rendobar-Client` for usage attribution.
- Migrate file upload to the `/assets` presigned flow.
- Stop shipping source maps; fix a stale job-type placeholder.
