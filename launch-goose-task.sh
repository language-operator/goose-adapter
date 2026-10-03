#!/bin/sh
# Task mode: what the base runs when AGENT_EXECUTION_MODE=task. The exit code
# is the run's phase — 0 Succeeded, anything else Failed.
#
# The prompt is spec.instructions, written to $GOOSE_PATH_ROOT/task.md at seed
# time and handed to Goose as a file, which sidesteps argv size limits. The
# persona stays standing context in .goosehints. --no-session keeps one-shot
# runs out of the session list the service launcher resumes from.
#
# Goose's own exit code is not enough. `goose run` exits 0 when the gateway
# refuses the connection or answers 400/404/429/5xx — a bad model name included
# — and reports the failure as an assistant message instead (goose#4612; only
# 401/403 exit non-zero). That message is made up locally, so unlike a real
# answer it carries no `inference` metadata naming the provider and model that
# produced it. The run counts as failed when the last message is such an
# assistant message, or when there is no result to read at all.
set -eu

state="${GOOSE_PATH_ROOT:?GOOSE_PATH_ROOT is set by runtime.json}"
task="$state/task.md"
if [ ! -s "$task" ]; then
    echo "launch-goose-task: $task is empty — a task-mode agent needs spec.instructions" >&2
    exit 1
fi
# shellcheck disable=SC1091  # written at seed time
[ -f "$state/gateway.env" ] && . "$state/gateway.env"

out="$(mktemp)"
trap 'rm -f "$out"' EXIT

# Streamed to the pod log as it arrives, and kept for the check below. The
# status goes through a file because a pipeline reports only its last command's.
rc_file="$(mktemp)"
{ goose run --instructions "$task" --no-session --output-format json; echo "$?" > "$rc_file"; } | tee "$out"
status="$(cat "$rc_file")"
rm -f "$rc_file"
if [ "$status" -ne 0 ]; then
    echo "launch-goose-task: goose exited with status $status" >&2
    exit "$status"
fi

# The JSON result follows a banner on the same stream; read from its first line.
# shellcheck disable=SC2016  # JavaScript, not shell: nothing here should expand
sed -n '/^{/,$p' "$out" | node -e '
let raw = "";
process.stdin.on("data", (d) => { raw += d; }).on("end", () => {
  let result;
  try { result = JSON.parse(raw); } catch {
    console.error("launch-goose-task: goose produced no result to check");
    process.exit(1);
  }
  const last = (result.messages ?? []).at(-1);
  const text = (last?.content ?? []).map((c) => c.text ?? "").join("").trim();
  const failed = !last
    || (last.role === "assistant" && !last.metadata?.inference)
    || /^(Ran into this error|Network error):/.test(text);
  if (failed) {
    console.error(`launch-goose-task: the run failed: ${text.split("\n")[0] || "no answer"}`);
    process.exit(1);
  }
});
'
