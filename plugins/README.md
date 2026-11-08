# Garmin plugin packages

Public release ZIPs are templates. They use `https://garmin.example.test/mcp`,
which is an example address, not a shared Garmin service. Deploy your own Worker first.

From the repository checkout, build both ZIPs for your deployment:

```sh
npm run package:plugins -- --url https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/mcp
```

Find `garmin-chatgpt.zip`, `garmin-claude.zip`, and `SHA256SUMS` in `dist/plugins/`.
Alternatively, extract a release ZIP, replace the URL in `mcp.json` (ChatGPT)
or `.mcp.json` (Claude), then re-zip its contents, including hidden files.

- ChatGPT: upload the ChatGPT ZIP through Plugins > Add > Upload plugin archive.
- Claude: upload the Claude ZIP through Customize > Plugins > Add > Upload plugin,
  then add or connect Garmin from its Connectors tab.

Organization plans may need an administrator to allow uploads and custom MCP
connectors. A plugin upload does not complete OAuth sign-in. Approve your own
server in the browser with its owner access code. Keep the plugin unshared.

These packages include a real remote MCP connection definition and a helper
skill. They contain no Garmin session, password, access code, or encryption key.
Never put those values into the archives or release settings.

## Maintainers

Publish a GitHub release for a tag matching `v` plus the package version.
The Plugin release workflow tests the tagged source and attaches both template
ZIPs and their checksums. Its manual Run workflow option can attach them to an
existing release. Re-running replaces only these three named assets.
