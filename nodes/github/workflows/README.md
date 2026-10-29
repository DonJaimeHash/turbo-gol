# Workflow templates

GitHub only runs `.github/workflows/`, so the workflows here are templates. To turn one on, copy it
there with the action versions of `.github/workflows/ci.yml` (the repo allows only GitHub-owned
actions). `tests/workflows.test.mjs` checks the templates like the active workflows.

- `node-release.yml` is no longer here: it is active as
  [`.github/workflows/node-release.yml`](../../../.github/workflows/node-release.yml) (build, sign
  and publish a community-node release from a `node-vX.Y.Z` tag).
- `top-requests.yml` is for stage 2 (`nodes/docs/PRODUCCION.md`).
- The community bot's template (`community-bot.yml`) was removed on 2026-10-29 (security audit,
  repo-7). As written, a proposal could hide instructions in an HTML comment that the rendered
  issue does not show; the bot read the raw text with `ANTHROPIC_API_KEY` in its environment, a
  write-scoped token and `npm test` among its tools, so one test file could send both away. A bot
  workflow added later must, before it is turned on:
  - run the model in a job that executes nothing the bot wrote or the issue chose: no Bash tools
    at all (git included: a hook or a `.git/config` written with Edit makes git run code), no
    `npm ci` with install scripts;
  - run the tests in a second job with no secrets and a read-only token, on the bot's branch;
  - drop `id-token: write`, use `persist-credentials: false`, and grant write only to the step
    that opens the pull request;
  - start only for maintainers named in the workflow (`github.event.sender.login`), not for
    anyone who can label;
  - give the model a maintainer-written summary of the proposal, never the raw issue body;
  - pin the action by commit SHA, and put a spend limit on the API key's workspace.
