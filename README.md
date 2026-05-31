# n8n-nodes-rendobar

n8n community node for [Rendobar](https://rendobar.com), a media processing API. Submit, track, and cancel video jobs from your workflows.

[n8n](https://n8n.io) is a fair-code workflow automation platform.

## Installation

In n8n, go to **Settings > Community Nodes** and install `n8n-nodes-rendobar`. See the n8n [community nodes docs](https://docs.n8n.io/integrations/community-nodes/installation/) for details.

## Credentials

You need a Rendobar API key (starts with `rb_`). Create one in the [dashboard](https://app.rendobar.com). The connection is validated against your account when you save it.

## Operations

**Rendobar** node:

- **Create Job** — submit a job. Pick the job type from a dropdown that is loaded live from your account, then fill in the parameters. The parameter fields are discovered from the API, so new job types appear without updating this node. Each submission sends an idempotency key derived from the n8n execution, so a retried step never creates a duplicate job. Turn on **Wait for Completion** to poll until the job finishes and return its result (best for short jobs; for long jobs use the Trigger).
- **Get Job** — fetch a job by ID, including its status and output URL.
- **Cancel Job** — cancel a job that is still running.

## Compatibility

Tested against n8n's current community-node API (`n8nNodesApiVersion: 1`).

## Resources

- [Rendobar docs](https://rendobar.com/docs)
- [n8n community nodes](https://docs.n8n.io/integrations/community-nodes/)

## License

[MIT](LICENSE.md)
