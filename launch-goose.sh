#!/bin/sh
# Service mode: what tmux runs inside the terminal.
#
# Config — provider, model, MCP extensions — is read from
# $GOOSE_PATH_ROOT/config/config.yaml and standing context from
# $GOOSE_PATH_ROOT/config/.goosehints, both written by `coding-runtime seed`.
# The gateway key reaches Goose through the environment only, so it comes from
# gateway.env, which holds a reference to $MODEL_API_KEY rather than its value.
# The base already starts tmux in the working directory, and Goose works in the
# directory it is started in, so the session opens on the project.
#
# Sessions live on the workspace PVC, in $GOOSE_PATH_ROOT/data/sessions, which
# outlives the pod. Sleeping an agent destroys the pod and waking it makes a new
# one, and this exec is the only moment a resume decision can be made — tmux is
# started with `new-session -A`, so on a reconnect to a live pod the launcher is
# never re-run. `--resume` is passed only when Goose lists a session to resume:
# with none it is an error ("No session found to resume"), not a fresh start.
#
# Goose is not exec'd: when it exits non-zero — no model configured, a gateway
# it cannot reach — the terminal falls back to a shell instead of the tmux pane
# closing on an error nobody saw. A clean exit (the user quit) ends the session.
set -u

state="${GOOSE_PATH_ROOT:?GOOSE_PATH_ROOT is set by runtime.json}"
# shellcheck disable=SC1091  # written at seed time
[ -f "$state/gateway.env" ] && . "$state/gateway.env"

set --
case "$(goose session list --format json --limit 1 2>/dev/null)" in
    *'"id"'*) set -- --resume ;;
esac

status=0
goose session "$@" || status=$?
if [ "$status" -ne 0 ]; then
    printf '\ngoose exited with status %s; starting a shell instead.\n\n' "$status"
    exec "${SHELL:-/bin/bash}"
fi
