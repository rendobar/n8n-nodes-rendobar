# n8n-nodes-rendobar

The verified n8n community node for Rendobar, published as `@rendobar/n8n-nodes-rendobar`.

## Keep search aliases in step with what Rendobar can do

n8n's nodes panel search matches only a node's display name and its `codex.alias`. The Job Type dropdown and the
Parameters form load from the API, so a new job type works without a release. Nobody finds the node by searching for
that job's task, though, until its words are in the aliases.

When a job type ships, or the node gains a capability:

1. Add the tasks people would type, such as `compress video` or `speech to text`, to `codex.alias` in both
   `nodes/Rendobar/Rendobar.node.json` and the inline `codex` in `Rendobar.node.ts`. Do the same for the trigger when it
   applies.
2. Map the job type to those terms in `JOB_TYPE_SEARCH_TERMS` in `.github/scripts/check-api-drift.mjs`. The weekly API
   drift issue flags a live job type with no terms.
3. Release a new version. n8n Cloud users see new aliases only after n8n picks that version up from npm.

Rules for terms. `test/verification.test.js` enforces the first two.

- **Keep the inline codex identical to the `.node.json` file.** n8n's registry reads the inline one, and the registry is
  what search sees before install. With the file alone, the registry stored `codex: {}`.
- **At most 3 words and 20 characters, with no duplicates.** A query matches when its letters appear in order inside one
  alias, so long phrases match unrelated searches. Prefer plurals: `captions` also catches `caption`.
- **Only name things the node does.** Avoid generic words (`account`, `download`, `storage`) and other products or
  platforms (`YouTube`, `S3`, competitors). They surface Rendobar in searches for other nodes.

## Icons

Before install, n8n draws one icon per node from its registry, whichever variant it stored.
- Both `icons/rendobar.svg` and `icons/rendobar.dark.svg` must be visible on the light and dark themes, which is why both
  are tiles.
- They must also stay different files. The `icon-validation` lint rule rejects light and dark pointing at the same file.

## Releasing

Releasing is a tag push, not a merge.
1. Merge to `main`.
2. Push the `x.y.z` tag. `publish.yml` publishes with provenance.
3. Once npm serves the new version, re-run the `Scan published package` job.

Bump `package.json`, the lockfile and `NODE_VERSION` in `nodes/Rendobar/shared/version.ts` together. A test checks that
they match.

## Templates

`templates/src/build.mjs` generates the quote, shorts, listing and upload QC templates. For those, edit `build.mjs` or
`templates/src/render/*.js`, run `node templates/src/build.mjs`, and never edit their JSON. The FFmpeg, auto-caption and
compress templates are written by hand, so edit their JSON directly.
