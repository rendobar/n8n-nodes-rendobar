# Changelog

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
