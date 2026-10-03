# -----------------------------------------------------------------------------
# Goose adapter.
#
# The OS layer, the web terminal, tini, and the /etc/agent/config.yaml ETL all
# live in coding-runtime. What is left here is the Goose CLI plus the three
# files that describe it to the base: a manifest, an emitter, and a launcher.
#
# The base is pinned by tag *and* digest. Never :latest, and never a `main`
# build — metadata-action stamps those with the version literal `main`, which no
# `requires.codingRuntime` range can satisfy, so every boot would warn about a
# version mismatch that is not real.
# -----------------------------------------------------------------------------
ARG BASE=ghcr.io/language-operator/coding-runtime:0.1.6@sha256:318a540d9d062689d3ed6c0de34fb353ff076bb16c5770bcf296398c6e5a5412
ARG GOOSE_VERSION=1.53.0
# Goose publishes no checksums with its releases, so they are pinned here.
# Recompute both whenever GOOSE_VERSION moves (see /update-dependencies).
ARG GOOSE_SHA256_AMD64=deb2191a6b75acc0a20232fc5c52655ea2f9cc8fa2f5dffc8622e8d378a915dc
ARG GOOSE_SHA256_ARM64=01a0ea109e1984e7a511ff3f99d1a29d32e6f90f0852b5a3b416499c8eaae567

FROM ${BASE}
ARG TARGETARCH
ARG GOOSE_VERSION
ARG GOOSE_SHA256_AMD64
ARG GOOSE_SHA256_ARM64

# Goose CLI (TUI): a single Rust binary from the GitHub release. The base is
# Debian (glibc), so the -gnu build. Pinned and checksummed — do not track
# `latest`, so runtime behaviour is reproducible.
USER root
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
        amd64) arch=x86_64;  sha="${GOOSE_SHA256_AMD64}" ;; \
        arm64) arch=aarch64; sha="${GOOSE_SHA256_ARM64}" ;; \
        *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    tarball="goose-${arch}-unknown-linux-gnu.tar.gz"; \
    curl -fsSL -o "/tmp/${tarball}" \
        "https://github.com/aaif-goose/goose/releases/download/v${GOOSE_VERSION}/${tarball}"; \
    echo "${sha}  /tmp/${tarball}" | sha256sum -c -; \
    tar -xzf "/tmp/${tarball}" -C /usr/local/bin ./goose; \
    rm "/tmp/${tarball}"; \
    chmod 755 /usr/local/bin/goose; \
    goose --version

# runtime.json  — what this adapter is: config dir, serving surface, tmux launch.
# emit.mjs      — normalized operator config -> Goose's config.yaml.
# launch-goose  — what tmux runs inside the terminal.
COPY runtime.json /etc/coding-runtime/runtime.json
COPY emit.mjs /opt/adapter/emit.mjs
COPY --chmod=755 launch-goose.sh /usr/local/bin/launch-goose

# The operator pins the agent container to uid 1000 with no override, and the
# base already has a matching passwd entry. Do not create a user here.
USER node
