# Workflow templates

GitHub only runs `.github/workflows/`, so the workflows here are templates. To turn one on, copy it
there with the action versions of `.github/workflows/ci.yml` (the repo allows only GitHub-owned
actions).

- `node-release.yml` is no longer here: it is active as
  [`.github/workflows/node-release.yml`](../../../.github/workflows/node-release.yml) (build, sign
  and publish a community-node release from a `node-vX.Y.Z` tag).
- `community-bot.yml` and `top-requests.yml` are for stage 2 (`nodes/docs/PRODUCCION.md`).
