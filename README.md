# goose-adapter

The **Goose** runtime for the [Language Operator](https://github.com/language-operator/language-operator),
running as a native Kubernetes workload. This repo was created from the opencode-adapter template.

It builds the runtime image and the Helm chart that registers the `goose`
`LanguageAgentRuntime`. The [Goose](https://github.com/aaif-goose/goose) CLI runs inside
tmux and is fronted by an xterm.js / WebSocket terminal in the browser, so working with the
agent feels like a real terminal session.

> **Status:** the rename is done; the Goose integration is not. Until
> [#1](https://github.com/language-operator/goose-adapter/issues/1) translates the
> operator's gateway, models and MCP servers into Goose's config, Goose starts with no
> provider and the terminal falls back to a shell.

## Architecture

The image is [`coding-runtime`](https://github.com/language-operator/coding-runtime)
plus the Goose CLI, a pinned and checksummed binary from the Goose GitHub release. The
base owns the OS layer, the web terminal (xterm.js over a node-pty WebSocket bridge, with
a cross-origin guard and a 25s keepalive), `tini`, and the ETL that turns the operator's
`/etc/agent/config.yaml` into a normalized config. What lives here is the three files that
describe Goose to it:

- **`runtime.json`** — the manifest: Goose's state root (`GOOSE_PATH_ROOT=$STATE_DIR/goose`),
  telemetry off so a headless pod never waits on the consent prompt, the serving surface,
  and how tmux launches the CLI.
- **`emit.mjs`** — the emitter: normalized config → `$GOOSE_PATH_ROOT/config/config.yaml`.
  Interim: it only settles telemetry and keeps the standing instructions on disk; provider,
  model and MCP translation is #1.
- **`launch-goose.sh`** — what tmux runs. The base has already set the working directory
  (the cloned repo when the agent sets `spec.repository`, else `/workspace`), so
  `goose session` opens on the project. If Goose exits with an error the terminal falls
  back to a shell rather than closing on a message nobody saw.

One container, running the base entrypoint: resolve the environment, seed config,
serve. Seeding runs in the agent container rather than an init container because
the operator mounts `/tmp` there only, so the two would share no writable path.
tmux keeps the session alive across browser reconnects.

The sibling [`claude-code-adapter`](https://github.com/language-operator/claude-code-adapter)
is the same shape on the same base, swapping the CLI and the three files.

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
no interactive login is needed (wired up in #1).

## Development

```bash
make build      # docker build -t ghcr.io/language-operator/goose-adapter:latest .
make test       # build, then run the coding-runtime conformance suite
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
  tolerated.
