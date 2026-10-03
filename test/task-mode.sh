#!/usr/bin/env bash
# Task mode, end to end: the image under test runs one task-mode agent against a
# mock gateway, the way the operator runs it (read-only root, uid 1000, all
# capabilities dropped, tmpfs /tmp, AGENT_EXECUTION_MODE=task).
#
# The conformance suite proves the base honours task.exec, but with manifests of
# its own; nothing there runs launch-goose-task or Goose. This does, and checks
# what the issue asks of a task agent:
#
#   - a good model: exit 0, with the instructions sent as the prompt and the
#     per-agent key ($(MODEL_API_KEY), sourced from gateway.env as a reference)
#     as the bearer;
#   - a bad model name: a non-zero exit, so the run is Failed — the case Goose
#     itself exits 0 on, which launch-goose-task catches;
#   - no instructions: a non-zero exit naming the problem, not a hang.
#
# Usage: test/task-mode.sh <image>
set -euo pipefail

IMAGE="${1:?usage: task-mode.sh <image>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORKDIR="$(mktemp -d)"
NET="goose-task-$$"
MOCK="goose-task-mock-$$"
MODEL="goose-test-model"
KEY="sk-task-mode-test"
FAIL=0

cleanup() {
    local status=$?
    docker rm -f "$MOCK" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    # The agent runs as uid 1000 and writes into the bind-mounted workspace;
    # remove those files from a root container, since the caller may not be 1000.
    docker run --rm -v "$WORKDIR:/w" --user 0:0 --entrypoint sh "$IMAGE" \
        -c 'rm -rf /w/*' >/dev/null 2>&1 || true
    rm -rf "$WORKDIR" 2>/dev/null || true
    return "$status"
}
trap cleanup EXIT

docker network create "$NET" >/dev/null
# The image under test already carries node, so the mock needs no other image.
docker run -d --name "$MOCK" --network "$NET" --network-alias gateway \
    -v "$HERE/mock-gateway.mjs:/mock-gateway.mjs:ro" -e MOCK_MODEL="$MODEL" \
    --entrypoint node "$IMAGE" /mock-gateway.mjs >/dev/null
for _ in $(seq 1 30); do
    docker logs "$MOCK" 2>&1 | grep -q 'mock gateway on' && break
    sleep 1
done

# run_task <name> <model> <instructions>: one task-mode run on a fresh
# workspace. Prints the agent's output; returns its exit code.
run_task() {
    local name="$1" model="$2" instructions="$3" dir="$WORKDIR/$1"
    mkdir -p "$dir/workspace" "$dir/etc-agent"
    chmod 777 "$dir/workspace"
    {
        echo "agent: {name: $name, namespace: default}"
        [ -n "$instructions" ] && echo "instructions: '$instructions'"
        echo "models:"
        echo "  primary: {role: primary, model: $model, endpoint: 'http://gateway:18080'}"
    } > "$dir/etc-agent/config.yaml"
    docker run --rm --network "$NET" \
        --read-only --tmpfs /tmp:rw,size=256m \
        --user 1000:1000 --cap-drop ALL \
        -v "$dir/workspace:/workspace" \
        -v "$dir/etc-agent:/etc/agent:ro" \
        -e AGENT_NAME="$name" -e AGENT_NAMESPACE=default \
        -e AGENT_EXECUTION_MODE=task \
        -e MODEL_API_KEY="$KEY" \
        "$IMAGE" 2>&1
}

check() {
    local description="$1"; shift
    if "$@"; then
        echo "  ok   $description"
    else
        echo "  FAIL $description"
        FAIL=$((FAIL + 1))
    fi
}

# A good model completes. The marker proves the instructions were the prompt,
# and the bearer that the per-agent key went through as an env reference.
good() {
    local out status=0
    out="$(run_task good "$MODEL" 'Reply with TASK-MARKER-7.')" || status=$?
    if [ "$status" != 0 ]; then
        printf '%s\n' "wanted exit 0, got $status" "$out"
        return 1
    fi
    local log
    log="$(docker logs "$MOCK" 2>/dev/null | grep '"url":"/v1/chat/completions"' | grep "\"model\":\"$MODEL\"" || true)"
    if ! grep -q 'TASK-MARKER-7' <<<"$log"; then
        printf '%s\n' "the gateway never saw the instructions as a prompt" "$out"
        return 1
    fi
    if ! grep -q "\"auth\":\"Bearer $KEY\"" <<<"$log"; then
        printf '%s\n' "the gateway never saw the per-agent key as the bearer" "$out"
        return 1
    fi
}
check "a task run with a good model exits 0, prompted by the instructions" good

bad_model() {
    local out status=0
    out="$(run_task bad no-such-model 'Reply with anything.')" || status=$?
    [ "$status" != 0 ] && return 0
    printf '%s\n' "wanted a non-zero exit for a bad model name, got 0" "$out"
    return 1
}
check "a task run with a bad model name exits non-zero" bad_model

no_instructions() {
    local out status=0
    out="$(run_task empty "$MODEL" '')" || status=$?
    [ "$status" != 0 ] && grep -q 'spec.instructions' <<<"$out" && return 0
    printf '%s\n' "status=$status (wanted non-zero, output naming spec.instructions)" "$out"
    return 1
}
check "a task run with no instructions fails, saying so" no_instructions

if [ "$FAIL" -gt 0 ]; then
    echo "task mode: $FAIL check(s) failed"
    exit 1
fi
echo "task mode: all checks passed"
