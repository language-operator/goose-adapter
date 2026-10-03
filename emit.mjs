/**
 * Goose emitter.
 *
 * Goose reads $GOOSE_PATH_ROOT/config/config.yaml, and runtime.json sets
 * GOOSE_PATH_ROOT to ${STATE_DIR}/goose. JSON is valid YAML, so the file goes
 * through the base's JSON writer, which manages only the keys listed in `owns`.
 * Every owned key is supplied on every run, null included, so a withdrawn model
 * or tool is removed rather than left behind. Caveat: `goose configure` rewrites
 * the file as block YAML, which that writer cannot parse; the next seed moves it
 * aside (`config.yaml.corrupt-*`, with a CONFIG_FILE_QUARANTINED warning) and
 * rebuilds it from the owned keys, so those edits do not survive a restart.
 * Configure through the operator, not through `goose configure`.
 *
 * Every model is reached through the cluster gateway with Goose's `openai`
 * provider: the gateway is OpenAI-compatible and aggregates all of them behind
 * one endpoint.
 */

/** The placeholder the gateway accepts when no per-agent key was issued. */
const PLACEHOLDER_KEY = 'sk-langop-proxy';

/**
 * Split the gateway's OpenAI base URL into Goose's host and path.
 *
 * Goose joins OPENAI_HOST and OPENAI_BASE_PATH itself, so a host that already
 * ends in /v1 would be called as /v1/v1/chat/completions. The path is absolute
 * on purpose: Goose replaces the host's path with it, and any base path other
 * than its default stops it rerouting gpt-5* and o1*-style model names to the
 * Responses API, which the gateway is not promised to serve.
 */
function gatewayEndpoint(openaiBaseUrl) {
  const url = new URL(openaiBaseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  return { host: url.origin, basePath: `${path}/chat/completions` };
}

/**
 * The line that puts the gateway key in Goose's environment.
 *
 * Goose reads OPENAI_API_KEY from the environment or its secret store, never
 * from config.yaml, and has no reference syntax of its own. So the emitter
 * writes a shell line the launchers source, holding a reference to the
 * per-agent key rather than its value — the file lives on the workspace volume.
 * Without a key, or on a base too old to render references, it falls back to
 * the shared placeholder: a missing key costs usage attribution, not the boot.
 */
function gatewayEnv(config, renderRef) {
  const ref = config.gateway.apiKeyRef && renderRef
    ? renderRef(config.gateway.apiKeyRef, { path: 'gateway.apiKey', rewrite: (name) => `\${${name}}` })
    : null;
  if (ref !== null && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(ref)) {
    return `export OPENAI_API_KEY="${ref}"\n`;
  }
  return `export OPENAI_API_KEY='${config.gateway.apiKey ?? PLACEHOLDER_KEY}'\n`;
}

export function emit(config, { env = {}, renderHeaders = null, renderRef = null } = {}) {
  const configDir = config.paths.stateDir ? `${config.paths.stateDir}/goose` : '/etc/goose';
  const task = String(env.AGENT_EXECUTION_MODE ?? '').trim().toLowerCase() === 'task';

  // An external server's headers go in as `${NAME}`, which Goose expands only
  // for names listed in the extension's env_keys, read from the agent's
  // environment when it connects — so the token is never written to disk.
  // Rendering is all-or-nothing: a server whose headers cannot all be rendered
  // is left out (the helper warns), never configured without auth to 401
  // unexplained. A base without the helper cannot honour headers at all.
  const extension = (tool) => {
    const entry = { enabled: true, type: 'streamable_http', name: tool.name, uri: tool.endpoint };
    if (!tool.headers) return entry;
    if (!renderHeaders) {
      throw new Error(`tool '${tool.name}' has headers, which need coding-runtime's ctx.renderHeaders; rebuild on a base that provides it`);
    }
    const names = new Set();
    const headers = renderHeaders(tool.headers, {
      path: `tools.${tool.name}`,
      rewrite: (name) => { names.add(name); return `\${${name}}`; },
      clientSyntax: /\$\{?[A-Za-z_]/,
    });
    if (!headers) return null;
    return { ...entry, headers, env_keys: [...names].sort() };
  };

  const writes = [];
  const values = {
    GOOSE_TELEMETRY_ENABLED: false,
    // Headless runs must never stop to ask before a tool call: in approve
    // modes `goose run` turns the confirmation into an error.
    GOOSE_MODE: 'auto',
    GOOSE_PROVIDER: null,
    GOOSE_MODEL: null,
    OPENAI_HOST: null,
    OPENAI_BASE_PATH: null,
    extensions: null,
  };
  const owns = Object.keys(values);

  if (config.gateway) {
    const { host, basePath } = gatewayEndpoint(config.gateway.openaiBaseUrl);
    values.GOOSE_PROVIDER = 'openai';
    values.OPENAI_HOST = host;
    values.OPENAI_BASE_PATH = basePath;
    if (config.models.primary) values.GOOSE_MODEL = config.models.primary.id;
  }

  const extensions = config.tools.map((tool) => [tool.name, extension(tool)]).filter(([, entry]) => entry);
  if (extensions.length > 0) values.extensions = Object.fromEntries(extensions);

  writes.push({ path: `${configDir}/config/config.yaml`, values, owns });

  writes.push({
    path: `${configDir}/gateway.env`,
    contents: config.gateway ? gatewayEnv(config, renderRef) : '',
  });

  // Standing context, which Goose loads from its global hints file at the start
  // of every session. In service mode that is the persona and the instructions,
  // so the TUI opens already briefed. In task mode the instructions are the
  // task itself, sent as the prompt, so only the persona stays here. Written
  // every run, empty included, so a withdrawn persona does not linger.
  const standing = (task ? [config.systemPrompt] : [config.systemPrompt, config.instructions]).filter(Boolean).join('\n\n');
  writes.push({ path: `${configDir}/config/.goosehints`, contents: standing ? `${standing}\n` : '' });

  // The task-mode prompt. Also written every run and empty when there are no
  // instructions, so a withdrawn task cannot be run again from a stale file.
  writes.push({ path: `${configDir}/task.md`, contents: config.instructions ? `${config.instructions}\n` : '' });

  return writes;
}

export default emit;
