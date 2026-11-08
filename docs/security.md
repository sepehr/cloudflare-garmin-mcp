# Security and recovery

One deployment serves one Garmin account. The MCP tools are read-only, but the
underlying Garmin login session is an account credential, not a read-only token.
Deploy a separate Worker for each owner. Never share the owner access code.

The setup command signs in on your computer. Password and verification-code
prompts use the terminal. The session travels to Cloudflare through a private
stdin pipe, not a command argument, source file, or build log. Bootstrap session,
AES encryption key, and owner-code hash use Cloudflare secret bindings. Cloudflare
encrypts secrets at rest. The current rotated Garmin session and refresh marker
are also encrypted with AES-256-GCM before Durable Object storage. They exist in
plaintext in runtime memory while in use. Cloudflare account administrators and
anyone who can deploy code to the Worker are trusted with these credentials.

OAuth clients must present the separate owner code during browser consent.
Public discovery and client registration do not grant Garmin access. OAuth
grants live in KV and are managed by Cloudflare's OAuth provider. The Garmin
session lives in one SQLite Durable Object, which serializes token refresh.
Request logs and traces are disabled to reduce credential and health-data
exposure. Use invocation status and CPU metrics first when diagnosing failures.

The wizard trusts the exact Worker origin you enter. Check it against the
Cloudflare dashboard. If you mistype it, correct `vars.PUBLIC_ORIGIN` in the
ignored `wrangler.local.jsonc`, then rerun setup with that corrected origin and
the same account and Worker name. Keep the provisioned KV binding and private
setup state. This changes the origin configuration, not the encryption key.

Keep the setup state file shown by the installer private and backed up. It
contains the encryption key and owner code. Do not store it in the repository.
Preserve the encryption key across updates. Losing or changing it makes stored
sessions unreadable. A new key does not migrate existing ciphertext.

If Garmin authentication expires or a rotating refresh has an unknown outcome,
run `npm run setup` again from the same checkout and with the same saved setup
state. A fresh local login replaces the bootstrap session while retaining the
encryption key and owner code. Do not share one rotating session with another
client. The installer refuses an existing Worker without matching local setup
state rather than guessing a replacement key.

Disconnect OAuth clients separately. A fresh Garmin login does not revoke
existing MCP grants. If access is compromised, disable the Worker first and
revoke its grants and Garmin login sessions before restoring service. Deleting
KV or Durable Object storage is not a routine recovery step.

Garmin Connect is an unofficial API. Sign-in can be blocked or rate limited.
This project is not affiliated with Garmin. It supports garmin.com accounts;
garmin.cn is not implemented.
