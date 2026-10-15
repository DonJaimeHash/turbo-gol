# Security policy

## Supported versions

Only the latest release and the `main` branch receive security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems (account takeover, ways to bypass
rate limits or ranked rules, injection, leaking other players' data, crashing the server...).

Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository.
Include the steps to reproduce, the impact, and any proof of concept. You will get an answer within
7 days; once a fix is released we credit the reporter (unless you prefer to stay anonymous).

## Scope notes for self-hosters

- Secrets (`JWT_SECRET`, `TURNSTILE_SECRET`, OAuth client secrets, Cloudflare API tokens) live in
  `server/.dev.vars` (local) or Wrangler secrets (deploy). They must never be committed; the
  repository ignores `.env*` and `.dev.vars*` files.
- Values in `server/wrangler.jsonc` (Worker name, KV namespace id, Turnstile *site* key, allowed
  origins) are public configuration, not secrets. Forks must replace them with their own.
- Turn the anti-bot check on (`TURNSTILE_DISABLED` = `"0"` with a site key and secret) before
  opening a deployment to the public.
