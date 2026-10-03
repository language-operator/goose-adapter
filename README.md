# goose-adapter

The **Goose** runtime for the [Language Operator](https://github.com/language-operator/language-operator),
running as a native Kubernetes workload. This repo was created from the opencode-adapter template.

It builds the runtime image and the Helm chart that registers the `goose`
`LanguageAgentRuntime`. The [Goose](https://github.com/aaif-goose/goose) CLI runs inside
tmux and is fronted by an xterm.js / WebSocket terminal in the browser, so working with the
agent feels like a real terminal session.

## Architecture

The image is [`coding-runtime`](https://github.com/language-operator/coding-runtime)
plus the Goose CLI, a pinned and checksummed binary from the Goose GitHub release. The
base owns the OS layer, the web terminal (xterm.js over a node-pty WebSocket bridge, with
a cross-origin guard and a 25s keepalive), `tini`, and the ETL that turns the operator's
`/etc/agent/config.yaml` into a normalized config. What lives here is the files that
describe Goose to it:

- **`runtime.json`** — the manifest: Goose's state root (`GOOSE_PATH_ROOT=$STATE_DIR/goose`),
  telemetry off and file-backed secrets so a headless pod never waits on a prompt or a
  keyring, the serving surface, how tmux launches the CLI, and the task-mode command.
- **`emit.mjs`** — the emitter. Into `$GOOSE_PATH_ROOT`:
  - `config/config.yaml` — the `openai` provider pointed at the cluster gateway, the
    primary model, and one `streamable_http` extension per MCP tool. A tool's `$(NAME)`
    header references become `${NAME}` plus `env_keys`, which Goose expands from the
    agent's environment, so no token is written to disk.
  - `gateway.env` — `OPENAI_API_KEY` as a reference to `$MODEL_API_KEY` (or the shared
    placeholder), sourced by the launchers: Goose reads the key from the environment only.
  - `config/.goosehints` — standing context: the persona, plus the instructions in
    service mode.
  - `task.md` — the instructions, the prompt for a task-mode run.
- **`launch-goose.sh`** — service mode, what tmux runs. The base has already set the
  working directory (the cloned repo when the agent sets `spec.repository`, else
  `/workspace`), so `goose session` opens on the project, with `--resume` once Goose has a
  session to resume, so a slept agent wakes into its conversation. If Goose exits with an
  error (a bad model, an unreachable gateway) the terminal falls back to a shell rather
  than closing on a message nobody saw.
- **`launch-goose-task.sh`** — task mode (`spec.execution.mode: task`): one
  `goose run` of `task.md`, whose exit code is the run's phase. Goose exits 0 on most
  gateway errors (bad model, 4xx/5xx, unreachable), reporting them as an assistant
  message, so the launcher fails the run when the final message did not come from the
  model.

One container, running the base entrypoint: resolve the environment, seed config,
serve. Seeding runs in the agent container rather than an init container because
the operator mounts `/tmp` there only, so the two would share no writable path.
tmux keeps the session alive across browser reconnects.

The sibling [`claude-code-adapter`](https://github.com/language-operator/claude-code-adapter)
is the same shape on the same base, swapping the CLI and these files.

## Install

Prerequisite: the [`language-operator`](https://github.com/language-operator/language-operator)
chart must be installed first — it provides the `LanguageAgentRuntime` CRD.

```bash
helm install goose oci://ghcr.io/language-operator/charts/goose \
  --namespace language-operator
```

Then reference it from a `LanguageAgent`:

```yaml
apiVersion: langop.io/v1alpha1
kind: LanguageAgent
metadata:
  name: my-agent
spec:
  runtime: goose
```

## Authentication

The runtime sets `auth.enabled: true`, so access is gated entirely by the cluster's
OIDC proxy: when the `LanguageCluster` has auth enabled the operator injects an
oauth2-proxy sidecar in front of the terminal. There is no built-in password — if
the cluster does not enable auth, the terminal is exposed unauthenticated on its
ingress. Goose reaches the model gateway via the provider config the emitter seeds;
no interactive login is needed.

## Development

```bash
make build      # docker build -t ghcr.io/language-operator/goose-adapter:latest .
make test       # build, then conformance, the emitter tests and the task-mode test
make publish    # build and push the image to ghcr.io
make dev        # build, import into k3s, and upgrade the runtime release (inner loop)

helm lint chart
helm template goose chart
```

## CI

- `build-image.yaml` — builds and pushes the image to `ghcr.io` on push to `main` and `v*` tags.
- `release-chart.yaml` — packages `chart/` and pushes it to `oci://ghcr.io/language-operator/charts`.
- `test.yaml` — builds the image, runs the `coding-runtime` conformance suite against
  it under the operator's posture (read-only root, uid 1000, all capabilities dropped),
  and lints/templates the chart on every PR. The suite is taken out of the image rather
  than fetched, so the checks always match the runtime being checked, and no failures are
  tolerated. The same job runs the emitter tests (`test/emit.test.mjs`) inside the image,
  on the base's own normalizer, and `test/task-mode.sh`, which runs task-mode agents
  against a mock gateway: a good model exits 0, a bad model name and missing instructions
  exit non-zero.
