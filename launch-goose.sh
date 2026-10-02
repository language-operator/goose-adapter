#!/bin/sh
# Config is read from $GOOSE_PATH_ROOT/config/config.yaml, written by
# `coding-runtime seed`. The base already starts tmux in the working directory,
# and Goose works in the directory it is started in, so the session opens on
# the project.
#
# Goose is not exec'd: when it exits non-zero the terminal falls back to a
# shell instead of the tmux pane closing on an error nobody saw. Until issue #1
# translates the gateway into Goose's provider settings that is every boot —
# Goose stops with "No provider configured" — and after it, it is how a bad
# model or an unreachable gateway stays visible. A clean exit (the user quit)
# ends the session as before.
#
# Resume is also #1's: Goose keeps sessions in
# $GOOSE_PATH_ROOT/data/sessions/sessions.db, and `goose session --resume`
# should only be passed once that exists — a resume with nothing to resume is
# the failure the template's launcher had to guard against.
set -u

status=0
goose session "$@" || status=$?
if [ "$status" -ne 0 ]; then
    printf '\ngoose exited with status %s; starting a shell instead.\n\n' "$status"
    exec "${SHELL:-/bin/bash}"
fi
