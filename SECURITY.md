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

- Secrets (`JWT_SECRET`, `TURNSTILE_SECRET`, OAuth client secrets, the node control key) live in
  Wrangler secrets for a deploy; the deploy's Cloudflare API token in `server/.env`, or use
  `wrangler login`. `server/.dev.vars` is for local development only: give it development values
  (a throwaway `JWT_SECRET`, a separate development OAuth client), never production ones. None of
  these files may be committed; the repository ignores `.env*` and `.dev.vars*` files.
- The Vite dev server listens on 127.0.0.1 only and refuses `.dev.vars`, `.env*`, `.wrangler/`,
  `private/`, `.claude/` and the nodes' keys. `TG_LAN=1` puts it on the network for a test on a
  phone or a TV: do that only on a network you trust.
- Values in `server/wrangler.jsonc` (Worker name, KV namespace id, Turnstile *site* key, allowed
  origins) are public configuration, not secrets. Forks must replace them with their own.
- Turn the anti-bot check on (`TURNSTILE_DISABLED` = `"0"` with a site key and secret) before
  opening a deployment to the public.
