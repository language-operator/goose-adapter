/**
 * Goose emitter — interim.
 *
 * Goose reads $GOOSE_PATH_ROOT/config/config.yaml, and runtime.json sets
 * GOOSE_PATH_ROOT to ${STATE_DIR}/goose. JSON is valid YAML, so the file goes
 * through the base's JSON writer, which manages only the keys listed in `owns`.
 * Caveat for #1: `goose configure` rewrites the file as block YAML, which that
 * writer cannot parse, so whether user edits survive a reseed is still open.
 *
 * This only settles what a headless pod needs before anything else: telemetry is
 * decided, so Goose never sits on its consent prompt. Translating the gateway,
 * models and MCP servers into Goose's provider settings and extensions is issue
 * #1; until then Goose starts with no provider and the launcher falls back to a
 * shell.
 */
export function emit(config) {
  const configDir = config.paths.stateDir ? `${config.paths.stateDir}/goose` : '/etc/goose';
  const writes = [];

  // Kept so instructions the operator sends are on disk for #1 to wire in,
  // rather than dropped.
  const standing = [config.systemPrompt, config.instructions].filter(Boolean).join('\n\n');
  if (standing) {
    writes.push({ path: `${configDir}/instructions.md`, contents: `${standing}\n` });
  }

  writes.push({
    path: `${configDir}/config/config.yaml`,
    values: { GOOSE_TELEMETRY_ENABLED: false },
    owns: ['GOOSE_TELEMETRY_ENABLED'],
  });
  return writes;
}

export default emit;
