// Emitter tests, run against the base's own normalizer and emitter context, so
// the input is exactly what `coding-runtime seed` hands the emitter rather than
// a hand-built imitation of it. The base ships its source in the image, so CI
// runs these inside the image under test; locally, point CODING_RUNTIME_SRC at
// a coding-runtime checkout's src/ of the version the Dockerfile pins.
//
//   docker run --rm -v "$PWD:/adapter:ro" --entrypoint node <image> --test "/adapter/test/*.test.mjs"
//   CODING_RUNTIME_SRC=../coding-runtime/src node --test "test/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emit } from '../emit.mjs';

const SRC = process.env.CODING_RUNTIME_SRC ?? '/opt/coding-runtime/src';
const { normalize } = await import(`${SRC}/config/normalize.mjs`);
const { emitterContext } = await import(`${SRC}/emit.mjs`);

const PATHS = { workspace: '/workspace', stateDir: '/workspace/.coding-runtime' };
const GOOSE = '/workspace/.coding-runtime/goose';

const MODEL = `models:
  primary: {role: primary, model: gpt-test, endpoint: "http://gateway.ns.svc.cluster.local:8000"}
`;

function run(yamlText, env = {}) {
  const warnings = [];
  const config = normalize({ yamlText, env, paths: PATHS });
  const writes = emit(config, emitterContext({ env, onWarn: (w) => warnings.push(w) }));
  const byPath = Object.fromEntries(writes.map((w) => [w.path.slice(GOOSE.length + 1), w]));
  return { byPath, warnings };
}

test('no model: every owned key is stated, provider keys null', () => {
  const { byPath } = run('agent: {name: a, namespace: ns}\n');
  const config = byPath['config/config.yaml'];
  assert.deepEqual(config.values, {
    GOOSE_TELEMETRY_ENABLED: false,
    GOOSE_MODE: 'auto',
    GOOSE_PROVIDER: null,
    GOOSE_MODEL: null,
    OPENAI_HOST: null,
    OPENAI_BASE_PATH: null,
    extensions: null,
  });
  assert.deepEqual(config.owns, Object.keys(config.values));
  assert.equal(byPath['gateway.env'].contents, '');
  assert.equal(byPath['task.md'].contents, '');
  assert.equal(byPath['config/.goosehints'].contents, '');
});

test('a model: openai provider, host without /v1, absolute chat/completions path', () => {
  const { values } = run(MODEL).byPath['config/config.yaml'];
  assert.equal(values.GOOSE_PROVIDER, 'openai');
  assert.equal(values.GOOSE_MODEL, 'gpt-test');
  assert.equal(values.OPENAI_HOST, 'http://gateway.ns.svc.cluster.local:8000');
  assert.equal(values.OPENAI_BASE_PATH, '/v1/chat/completions');
});

test('the gateway key: a reference when MODEL_API_KEY is set, never the value', () => {
  const withKey = run(MODEL, { MODEL_API_KEY: 'sk-secret' }).byPath['gateway.env'].contents;
  assert.equal(withKey, 'export OPENAI_API_KEY="${MODEL_API_KEY}"\n');
  assert.doesNotMatch(withKey, /sk-secret/);
  const without = run(MODEL).byPath['gateway.env'].contents;
  assert.equal(without, "export OPENAI_API_KEY='sk-langop-proxy'\n");
});

test('tools become streamable_http extensions; header refs go through env_keys', () => {
  const yaml = `${MODEL}tools:
  ctl: {endpoint: "https://ctl.example/mcp", protocol: mcp, headers: {Authorization: "Bearer $(CTL_TOKEN)"}}
  local: {endpoint: "http://localhost:9000/mcp", protocol: mcp}
`;
  const { byPath } = run(yaml, { CTL_TOKEN: 'tok-secret' });
  assert.deepEqual(byPath['config/config.yaml'].values.extensions, {
    ctl: {
      enabled: true, type: 'streamable_http', name: 'ctl', uri: 'https://ctl.example/mcp',
      headers: { Authorization: 'Bearer ${CTL_TOKEN}' }, env_keys: ['CTL_TOKEN'],
    },
    local: { enabled: true, type: 'streamable_http', name: 'local', uri: 'http://localhost:9000/mcp' },
  });
  assert.doesNotMatch(JSON.stringify(byPath), /tok-secret/);
});

test('a tool whose header cannot be rendered is left out, with a warning', () => {
  const yaml = `${MODEL}tools:
  ctl: {endpoint: "https://ctl.example/mcp", protocol: mcp, headers: {Authorization: "Bearer $(CTL_TOKEN)"}}
`;
  const { byPath, warnings } = run(yaml);
  assert.equal(byPath['config/config.yaml'].values.extensions, null);
  assert.ok(warnings.some((w) => w.code === 'HEADERS_UNRESOLVED'), JSON.stringify(warnings));
});

const BRIEFED = `${MODEL}instructions: "Fix the flaky test."
personas: [{name: p, tone: terse, personality: careful}]
`;

test('service mode: persona and instructions are standing context', () => {
  const { byPath } = run(BRIEFED);
  const hints = byPath['config/.goosehints'].contents;
  assert.match(hints, /Tone: terse\./);
  assert.match(hints, /Fix the flaky test\./);
  assert.equal(byPath['task.md'].contents, 'Fix the flaky test.\n');
});

test('task mode: the instructions are the prompt, not standing context', () => {
  const { byPath } = run(BRIEFED, { AGENT_EXECUTION_MODE: 'task' });
  const hints = byPath['config/.goosehints'].contents;
  assert.match(hints, /Tone: terse\./);
  assert.doesNotMatch(hints, /Fix the flaky test/);
  assert.equal(byPath['task.md'].contents, 'Fix the flaky test.\n');
});
