---
description: Bring every pinned upstream dependency up to date, with an audit trail
argument-hint: "[all|base|goose|actions] (default: all)"
allowed-tools: Bash(git:*), Bash(gh:*), Bash(npm:*), Bash(curl:*), Bash(jq:*), Bash(docker:*), Bash(helm:*), Bash(make:*), Bash(diff:*), Read, Edit, Grep
---

Update the upstream dependencies of `goose-adapter`. Scope: **$ARGUMENTS** (empty means `all`).

This runs for security and compliance: the point is not only that versions move, but that
the move is **recorded** — old version, new version, digest, and what changed — so the PR
is the audit trail. A bump with no evidence behind it is worse than no bump, because it
looks reviewed.

## The dependency surface

This repo vendors almost nothing of its own; it is a thin layer over a base image. There
are four groups, and two of them span multiple files that must move together.

**1. The `coding-runtime` base image** — the OS layer, the web terminal, `tini`, and the
config ETL all come from here, so this is the security-relevant one.

| Location | Form |
|---|---|
| `Dockerfile` `ARG BASE` | `ghcr.io/language-operator/coding-runtime:X.Y.Z@sha256:…` — tag **and** digest |

`ARG BASE` is now the only place the base version appears: since base `0.1.1` the
conformance suite ships inside the image and CI extracts it from the build, so there is no
separate suite version to keep in step.

**2. The Goose CLI** — `Dockerfile` `ARG GOOSE_VERSION` plus `ARG GOOSE_SHA256_AMD64` and
`ARG GOOSE_SHA256_ARM64`, the release tarballs from `aaif-goose/goose`. Goose publishes no
checksums, so the two digests are computed here and move with the version, all three
together.

**3. GitHub Actions** — across `.github/workflows/{test,build-image,release-chart}.yaml`:
`actions/checkout`, `docker/setup-buildx-action`, `docker/login-action`,
`docker/metadata-action`, `docker/build-push-action`, `azure/setup-helm`.

**4. The manifest and emitter** — `runtime.json` and `emit.mjs` are owned by this repo:
`coding-runtime` ships no `examples/goose/` to copy them from. There is nothing to re-copy,
but when the base moves, read its `docs/authoring-an-adapter.md` and `docs/config-schema.md`
for contract changes these two files have to absorb.

**5. The `/iterate` command** — `.claude/commands/iterate.md` and the three scripts in
`.claude/commands/iterate/` are **verbatim copies** from `language-operator` (canonical, see
language-operator#932), except `iterate.md`'s `allowed-tools` build-tool entries and its
`## Testing` section, which are marked `<!-- per-repo -->`. These drift the same way the
files above do, and silently: a stale copy still runs, it just runs the old steps. Re-copy
the scripts wholesale; for `iterate.md`, lift the two per-repo regions out of the current
file, re-copy the canonical body, and put them back — then diff against canonical to prove
nothing else moved.

## Rules that must not be broken

- **Pin the base by tag *and* digest.** Never `:latest`.
- **Never pin a `main` or `sha-` build of the base.** `metadata-action` stamps those with
  the version literal `main`, which no `requires.codingRuntime` range in `runtime.json` can
  satisfy — every boot warns about a mismatch that is not real — and which also fails the
  conformance suite's own `reports a version` check, since that asserts semver. Only
  released semver tags.
- **Goose: take the latest *release* only** (`gh api repos/aaif-goose/goose/releases/latest`),
  never a pre-release or a `canary`/nightly build.
- **Goose: recompute both checksums from the downloaded tarballs.** Never copy a digest from
  anywhere else, and never drop the `sha256sum -c` to get past a mismatch.
- **Do not unpin anything to make an update easier.** If a pin is in the way, that is the
  finding — report it rather than loosening it.

## Steps

Stop and report if any precondition fails; do not continue past a failure.

**1. Preconditions.**
- On `main`, working tree clean (`git status --porcelain` empty), `git fetch origin` and
  confirm `main` is not behind `origin/main`.
- Create a branch, with something distinctive in the name —
  `git checkout -b chore/deps-<what-moved>`. Never work on `main`, and do not reuse a
  bare `chore/update-dependencies`: PRs here are squash-merged, so the old branch survives
  on the remote and its commits are not ancestors of `main`, which makes the next run's
  push a non-fast-forward rejection.

**2. Record the current state.** Read every pin listed above and write them down — this is
the "before" column of the audit trail.

```bash
grep -nE 'ARG (BASE|GOOSE_)' Dockerfile
grep -rn 'CODING_RUNTIME_VERSION' Makefile hack/conformance.sh .github/workflows/
grep -rn 'uses: .*@' .github/workflows/
```

**3. Discover the latest versions.** These commands are known to work here.

Base image — released semver tags only, then resolve the digest of the one you pick:

```bash
T=$(curl -s "https://ghcr.io/token?scope=repository:language-operator/coding-runtime:pull&service=ghcr.io" | jq -r .token)
curl -s -H "Authorization: Bearer $T" \
  "https://ghcr.io/v2/language-operator/coding-runtime/tags/list?n=1000" \
  | jq -r '.tags[]' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -5

curl -sI -H "Authorization: Bearer $T" \
  -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json" \
  "https://ghcr.io/v2/language-operator/coding-runtime/manifests/<X.Y.Z>" \
  | grep -i docker-content-digest
```

Goose CLI — the latest release, then the two tarballs' digests:

```bash
gh api repos/aaif-goose/goose/releases/latest --jq .tag_name
d="$(mktemp -d)"
gh release download <vX.Y.Z> --repo aaif-goose/goose --dir "$d" \
  -p 'goose-x86_64-unknown-linux-gnu.tar.gz' -p 'goose-aarch64-unknown-linux-gnu.tar.gz'
sha256sum "$d"/*.tar.gz
```

GitHub Actions — latest release per action:

```bash
for a in actions/checkout docker/setup-buildx-action docker/login-action \
         docker/metadata-action docker/build-push-action azure/setup-helm; do
  printf '%s: %s\n' "$a" "$(gh api "repos/$a/releases/latest" --jq .tag_name)"
done
```

**4. Read what changed, before editing anything.** For each dependency that has moved,
fetch the release notes and check for advisories. This is the compliance half of the task
and it is not optional:

```bash
gh release view <tag> --repo <owner>/<repo>            # release notes
gh api repos/<owner>/<repo>/security-advisories --jq '.[] | "\(.ghsa_id) \(.severity) \(.summary)"'
```

Note anything that reads as a security fix, and anything that reads as a breaking change.
A major-version jump in an action is a deliberate decision, not a routine bump — if the
notes describe a breaking change, either handle it in this PR or leave that pin alone and
record why.

**5. Apply the updates** for the requested scope.

- **Base:** update `ARG BASE` with the new tag **and** its digest, then the three
  `CODING_RUNTIME_VERSION` locations to the matching `vX.Y.Z`.
- **Manifest and emitter:** if the base's adapter contract changed (step 4 of the
  dependency surface above), absorb it in `runtime.json` / `emit.mjs` and describe it in the
  PR. A new manifest field this adapter should set is a real decision — surface it.
- **Goose:** update `ARG GOOSE_VERSION` and both `ARG GOOSE_SHA256_*` together.
- **Actions:** update the `uses:` pins.

**6. Re-read how the suite is obtained.** CI and `make test` extract
`/opt/coding-runtime/test/conformance.sh` from the built image. If a future base moves or
renames it, that breaks loudly rather than silently — fix the extraction, do not go back to
fetching a tag, which is what let the suite drift from the runtime in the first place.

**7. Verify.**

```bash
helm lint chart && helm template goose chart >/dev/null
make test        # builds the image and runs the conformance suite; needs Docker
```

If Docker is unavailable in this environment, say so plainly rather than implying the suite
ran — CI runs it on the PR, and the PR is where the evidence should land.

**8. Commit and open a PR.** One commit per dependency group, so a bad bump reverts on its
own. Never push to `main`; never tag — releasing is `/release`, and it is a separate
decision from updating. Merging is safe: chart publishing is restricted to `v*` tags, so a
merge does not publish anything.

The PR body is the audit record. For each dependency:

| | |
|---|---|
| Dependency | `ghcr.io/language-operator/coding-runtime` |
| Before → after | `0.1.0` → `0.1.1` |
| Digest | `sha256:…` |
| Notes | link to the release, one line on what changed |
| Security | the advisory it addresses, or "no advisories in range" |

End with what you did **not** update and why — a held-back major, a pin with a breaking
change, a dependency with no newer release. An empty "not updated" section should be
written as such, not omitted.

**9. Report.** Summarize what moved, what did not, and anything that needs a human decision.
If a bump carries a breaking change that this repo has to absorb — the `HOME` relocation in
the `0.1.0` migration is the worked example — say so explicitly and do not bury it in the
diff.
