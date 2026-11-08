# Project instructions

- Keep this a single-owner, read-only Garmin MCP server for Workers Free.
- Use TypeScript strict mode and the pinned Wrangler version. Generate binding
  types with `npm run types` after configuration changes.
- Never commit credentials, account IDs, deployed URLs, local setup state, or
  personal health data. Use example.test for fixtures.
- Never log passwords, authorization headers, OAuth forms, tokens, or Garmin
  response bodies. Cloudflare secret bindings hold bootstrap credentials;
  Durable Object session writes must remain encrypted.
- Preserve serialized refresh and fail closed on unknown refresh outcomes.
- Run `npm run check` and `npm test`. Tests must use fake upstream services.
  Do not exercise a real Garmin account or deploy while testing.
- Review code and failure-path tests before pushing. Keep changes small and
  remove unused code. Do not change live resources as part of repository work.
- Commit subjects use imperative present tense, start with a capital, and stay
  within 50 characters. Wrap bodies at 72 characters. Reference an existing
  issue when applicable; do not invent issue numbers. End with a `Changelog:`
  trailer, such as `Changelog: added`. Do not add AI attribution.
