# CLAUDE.md

Guidance for working in the `goose-adapter` repository. This repo was created from the
opencode-adapter template.

## What this is

A [Language Operator](https://github.com/language-operator) **runtime** that runs the
**Goose** CLI as a Kubernetes workload. Goose runs inside tmux and is fronted by an
xterm.js / WebSocket terminal, so working with the agent feels like a real terminal
session.

It is a **thin layer over
[`coding-runtime`](https://github.com/language-operator/coding-runtime)**. The base owns
the OS layer, the web terminal (node-pty over a WebSocket, with a cross-origin guard and
a keepalive), `tini`, and the ETL that turns the operator's `/etc/agent/config.yaml` into
a normalized config. This repo adds the Goose CLI plus three files that describe it to
the base.

One container, running the base entrypoint: resolve the environment, seed config, serve.
There is **no init container** — seeding happens in the agent container, because the
operator mounts `/tmp` there only, so an init container would share no writable path with
it.

## Key files

- `Dockerfile` — `FROM ${BASE}` plus the Goose release binary, pinned by
  `ARG GOOSE_VERSION` and verified against `ARG GOOSE_SHA256_AMD64`/`_ARM64` (Goose
  publishes no checksums, so they are computed here). `ARG BASE` pins the base by **tag
  and digest**, and is the only place the base version appears.
- `runtime.json` — the manifest: `GOOSE_PATH_ROOT=${STATE_DIR}/goose` (config at
  `config/config.yaml`, sessions at `data/sessions/sessions.db` under it), telemetry off,
  `GOOSE_DISABLE_KEYRING=1`, the serving surface, how tmux launches the CLI, and
  `task.exec` for task mode (needs base ≥0.1.5). **Owned here**: coding-runtime has no
  `examples/goose/` to copy it from.
- `emit.mjs` — the emitter, also owned here. `config/config.yaml` (JSON, which is valid
  YAML, through the base's JSON writer): `openai` provider, `OPENAI_HOST` **without**
  `/v1` (Goose would call `/v1/v1/…`) plus an absolute `OPENAI_BASE_PATH`, the model, and
  `streamable_http` extensions whose `$(NAME)` headers become `${NAME}` + `env_keys`.
  `gateway.env` carries `OPENAI_API_KEY` as a reference, because Goose reads it from the
  environment only. `config/.goosehints` is standing context; `task.md` the task prompt.
- `launch-goose.sh` — service mode: `goose session`, with `--resume` only when
  `goose session list` has one (resuming nothing is an error), falling back to a shell
  if Goose exits non-zero so the pane does not close on an unseen error.
- `launch-goose-task.sh` — task mode: `goose run` of `task.md`. Goose exits 0 on most
  gateway errors (goose#4612; only 401/403 exit non-zero), so the run fails when the final
  assistant message lacks `metadata.inference` — the mark of an error Goose made up
  locally rather than an answer from the model.
- `chart/` — the Helm chart registering the cluster-scoped `LanguageAgentRuntime` named
  `goose`.
- `.github/workflows/` — `test.yaml`, `build-image.yaml`, `release-chart.yaml`.

## Testing

- `make test` — builds the image and runs coding-runtime's conformance suite in `adapter`
  mode. The suite is **extracted from the image under test**, so the checks always match
  the runtime being checked; it runs the container the way the operator does (read-only
  root, uid 1000, all capabilities dropped). Needs Docker.
- `make lint-chart` — `helm lint chart` plus `helm template goose chart`.
- `make test` also runs, after conformance:
  - `test/emit.test.mjs` — emitter tests, run **inside the image** so they use the base's
    own `normalize` and `emitterContext`. Without Docker, run them against a coding-runtime
    checkout of the pinned version:
    `CODING_RUNTIME_SRC=<checkout>/src node --test "test/*.test.mjs"`.
  - `test/task-mode.sh` — task-mode agents against `test/mock-gateway.mjs`: a good model
    exits 0 with the instructions as the prompt and the per-agent key as the bearer; a bad
    model name and missing instructions exit non-zero.
- There is no linter. CI correctness is exactly the two `test.yaml` jobs: `image-test`
  (conformance, emitter tests, task mode) and `chart-lint`.
- Changes to the terminal, the emitter or the manifest are mostly **not** covered by
  anything local — the conformance suite checks the runtime contract, not Goose's
  behaviour. Say so plainly rather than implying a green build proves more than it does.
- The PR title must be a conventional commit (`feat:`, `fix:`, `chore:`, `docs:`).

## Build & dev deploy

- `make build` — build `ghcr.io/language-operator/goose-adapter:<git-sha>` + `:latest`.
- `make dev` — build, import into local k3s, and `helm upgrade` the runtime (requires the
  `language-operator` chart / `LanguageAgentRuntime` CRD installed first).
- `make publish` — push image tags to ghcr.io. `make uninstall` — remove the release.

## Releases

Cut a release with `/release major|minor|patch` (`.claude/commands/release.md`). Version
is kept in **lockstep**: `chart/Chart.yaml` `version` + `appVersion`, `chart/values.yaml`
`image.tag`, and the git tag `vX.Y.Z` all become the same `X.Y.Z`. Pushing a `v*` tag
triggers `build-image.yaml` and `release-chart.yaml`.

Two rules the hard way:

- **Chart publishing is restricted to `v*` tags.** It once ran on every push to `main`,
  which republished an already-published chart version in place — pairing a new template
  with the old image it names. `release-chart.yaml` also refuses to push a version that
  already exists.
- **Never pin a `main` or `sha-` build of the base.** Those record their version literal
  as `main`, which no `requires.codingRuntime` range can satisfy, and which fails the
  conformance suite's own semver check. Released tags only.

Bumping the base, the Goose CLI or the GitHub Actions is `/update-dependencies`, not
`/release` — they are separate decisions.

## Issue-driven workflow

`/iterate [#issue] [--auto]` handles **one** issue, from selection to a merged PR and a
closed issue, then stops. For continuous work, use `/loop /iterate`. Work happens inside a
git worktree under `.claude/worktrees/`.

It comes from the shared `langop` plugin in
[`language-operator/skills`](https://github.com/language-operator/skills), pinned to a tag
in `.claude/settings.json` — not from a copy in this repo, which is what it replaced.
`/iterate` and `/langop:iterate` both invoke it. There is nothing per-repo in the skill
itself: it reads `## Testing` above to learn how to test a change here, so keep that section
accurate.

Interactive sessions need no install step — the plugin loads at the pinned tag once the folder
is trusted. Non-interactive ones (`claude -p`, scheduled or in-cluster agents) have no trust
dialog, so they need this once, with the tag the repo pins:

```bash
claude plugin marketplace add 'language-operator/skills#v0.1.0'
claude plugin install langop@language-operator --scope project
```

Two things to avoid: a marketplace add without `#<tag>` follows `main` rather than the pin,
and `--scope project` on the *marketplace* add rewrites `.claude/settings.json` and drops
its `ref`. To take a newer release, change `ref` there.
