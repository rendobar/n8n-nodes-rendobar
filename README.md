# @rendobar/n8n-nodes-rendobar

n8n community node for [Rendobar](https://rendobar.com), a media processing API. Submit, track, and cancel video jobs from your workflows, and start workflows when jobs finish.

[n8n](https://n8n.io) is a fair-code workflow automation platform.

## Installation

In n8n, go to **Settings > Community Nodes** and install `@rendobar/n8n-nodes-rendobar`. See the n8n [community nodes docs](https://docs.n8n.io/integrations/community-nodes/installation/) for details.

## Credentials

You need a Rendobar API key (starts with `rb_`). Create one in the [dashboard](https://app.rendobar.com). The connection is validated against your account when you save it.

- **API Key** — your `rb_` key.
- **Base URL** — defaults to `https://api.rendobar.com`. Change it only to target another environment.

## Nodes

### Rendobar (action)

- **Create Job** — submit a job.
  - The **Job Type** dropdown is loaded live from your account, and the parameter fields are discovered from the API, so new job types appear without updating this node.
  - Each submission sends an idempotency key derived from the n8n execution, so a retried step never creates a duplicate job.
  - Optional **Wait for Completion**: poll until the job is done and return its result. It blocks the workflow, so it's best for short jobs — for long jobs use the trigger below. Configure the poll interval and a max-wait timeout.
- **Get Job** — fetch a job by ID, including its status and output URL.
- **Cancel Job** — cancel a job that is still running.
- **Upload File** — stream a binary file from a previous node to Rendobar and get back a URL to use as a job input. Files are ephemeral and auto-delete after 24 hours. Pair it with Create Job: upload, then reference the returned `downloadUrl` in the next node's inputs.

### Rendobar Trigger

Starts a workflow when a Rendobar event fires. Select the events to listen for (job completed, failed, cancelled, created, started, and balance events). On activation the node registers its webhook URL with Rendobar and removes it on deactivation.

> Rendobar must be able to reach the webhook URL over HTTPS. This works on n8n Cloud or a tunnelled / publicly hosted instance. A plain `localhost` n8n is not reachable from the API — use `n8n start --tunnel` to test locally.

## Compatibility

Tested against n8n's current community-node API (`n8nNodesApiVersion: 1`).

## Resources

- [Rendobar docs](https://rendobar.com/docs)
- [n8n community nodes](https://docs.n8n.io/integrations/community-nodes/)

## License

[MIT](LICENSE.md)
