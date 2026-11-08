# Garmin MCP on Cloudflare Workers

Read Garmin activities, sleep, heart rate, stress, HRV, and training metrics in
Claude, ChatGPT, or another remote MCP client. Self-host one account with
20 read-only tools, OAuth, and encrypted session storage. No container or paid
Cloudflare feature is required.

## Install

You need a Cloudflare account on Workers Free, Git, Node.js 24+, and
[uv](https://docs.astral.sh/uv/getting-started/installation/).
Run this on macOS, Linux, or WSL in your own terminal:

```sh
git clone https://github.com/sepehr/cloudflare-garmin-mcp.git && cd cloudflare-garmin-mcp && npm ci && npm run setup
```

The wizard asks for your Cloudflare account ID, Worker name, and full Worker URL
(for example `https://garmin.YOUR-SUBDOMAIN.workers.dev`). Find your account ID
and workers.dev subdomain in the Cloudflare dashboard. It opens Cloudflare
sign-in if needed, prompts locally for Garmin credentials and MFA, provisions
storage, and deploys the Worker. Use a new Worker name for your first install.

Garmin credentials are not printed or added to the repository. The session and
encryption key go to **Cloudflare Secrets** through a private input pipe.
The wizard saves your separate owner access code and encryption key in private
files outside the checkout and shows their paths. Back them up privately.
Your Garmin password is sent only to Garmin, never to Cloudflare.

## Connect

[![Add to VS Code](https://img.shields.io/badge/Add_to-VS_Code-007ACC)](https://sepehr.github.io/cloudflare-garmin-mcp/)
[![Add to Cursor](https://img.shields.io/badge/Add_to-Cursor-111111)](https://sepehr.github.io/cloudflare-garmin-mcp/)

After deployment, open either button, enter your own `/mcp` URL once, then
choose the installed desktop app. It asks you to review the connection and
complete OAuth. The page creates links locally and handles no credentials.

Add `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/mcp` as a remote MCP server
with OAuth in your client. In Claude, use **Customize → Connectors → Add custom
connector**. Approve the browser consent with your **owner access code**, not
your Garmin password. Organization plans may need an administrator to enable
custom connectors. Never paste credentials into a chat.

Try: “Summarize my activities and sleep for the last seven days.”

Prefer plugin uploads? Download the [release ZIPs](https://github.com/sepehr/cloudflare-garmin-mcp/releases/latest)
for ChatGPT and Claude. They are templates: [set your Worker URL before import](plugins/README.md).

## Updates and limits

To update code, pull changes, run `npm ci`, then
`npx wrangler deploy --config wrangler.local.jsonc`.
Keep the encryption key. To replace an expired Garmin session, rerun
`npm run setup` with the same private setup files. See [security and recovery](docs/security.md).

Workers, KV, and SQLite Durable Objects have free allowances. Usage limits,
including CPU time, still apply; this is not a guarantee that every request
fits the free limit. No plan upgrade is performed. See
[Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/).
Garmin's unofficial API can change or block sign-in. Only garmin.com is supported.

Activity lists are paginated. Follow `next_start` while `has_more` is true.
Missing readings are not zero. One deployment serves one Garmin account.

## Development

```sh
npm ci
npm run check
npm test
npm run setup -- --dry-run
```

Tests use fake Garmin responses. The dry run bundles locally without signing in
or deploying. See [AGENTS.md](AGENTS.md) for contribution rules.

Inspired by the minimal tool profile in
[taxuspt/garmin_mcp](https://github.com/taxuspt/garmin_mcp), rewritten in
TypeScript for Workers. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE).
