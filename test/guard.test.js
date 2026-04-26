#!/usr/bin/env node
/**
 * peer-ai guard tests — per-target / per-exchange-chain TTL semantics.
 *
 * Zero deps (Node assert + child_process). Uses a sandboxed HOME so the test
 * never touches the user's real ~/.peer-ai/ state.
 *
 * Scenarios:
 *   1. Five rapid invocations against the same target → 5th allowed, 6th blocked.
 *   2. Five invocations spread with the chain TTL exceeded between each → all
 *      allowed (each one starts a fresh chain because the prior chain expired).
 *   3. Per-target isolation: codex chain at the cap does NOT block gemini.
 *   4. Legacy rounds.json shape ({rounds, last_activity}) is migrated on read.
 *   5. Old chain entry (last_activity beyond TTL) is auto-cleared before count check.
 */
'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GUARD = path.resolve(__dirname, '..', 'bin', 'guard.js');

// Each test gets a fresh sandbox HOME so ~/.peer-ai/ is isolated.
function makeSandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-ai-test-'));
  fs.mkdirSync(path.join(home, '.peer-ai'), { recursive: true });
  return home;
}

function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
}

function writeConfig(home, config) {
  fs.writeFileSync(
    path.join(home, '.peer-ai', 'config.json'),
    JSON.stringify(config, null, 2),
    'utf8'
  );
}

function writeRoundsRaw(home, content) {
  fs.writeFileSync(path.join(home, '.peer-ai', 'rounds.json'), content, 'utf8');
}

function readRounds(home) {
  const p = path.join(home, '.peer-ai', 'rounds.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Invoke the guard with a stdin payload simulating a peer-ai call to `target`.
 * Returns { code, stderr } from the child process.
 */
function runGuard(home, target) {
  const cmds = {
    codex:  'codex exec --sandbox read-only --skip-git-repo-check - < /tmp/brief',
    claude: 'claude -p "$(cat /tmp/brief)"',
    gemini: 'gemini < /tmp/brief',
  };
  const payload = JSON.stringify({ tool_input: { command: cmds[target] } });

  const result = spawnSync('node', [GUARD], {
    input: payload,
    env: { ...process.env, HOME: home, PEER_AI_MAX_ROUNDS: '' },
    encoding: 'utf8',
  });

  return {
    code: result.status,
    stderr: result.stderr || '',
    stdout: result.stdout || '',
  };
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  const home = makeSandbox();
  try {
    fn(home);
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failed++;
  } finally {
    cleanup(home);
  }
}

console.log('peer-ai guard tests\n');

test('5 rapid invocations against same target: 5th allowed, 6th blocked', (home) => {
  writeConfig(home, { max_rounds: 5, ttl_minutes: 30, hard_block: true });
  for (let i = 1; i <= 5; i++) {
    const r = runGuard(home, 'codex');
    assert.strictEqual(r.code, 0, `call #${i} should be allowed (got code ${r.code}, stderr: ${r.stderr})`);
  }
  const r6 = runGuard(home, 'codex');
  assert.strictEqual(r6.code, 2, `call #6 should be blocked (got code ${r6.code})`);
  assert.match(r6.stderr, /consultation limit reached/i, 'block message should mention limit');
  assert.match(r6.stderr, /exchange chain/i, 'block message should mention exchange chain (not session)');
});

test('chain TTL expired for a target: counter auto-resets, fresh call allowed', (home) => {
  writeConfig(home, { max_rounds: 5, ttl_minutes: 30, hard_block: true });
  // Pre-seed: codex chain at the cap, but last_activity is 31 min ago.
  const oldTs = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  writeRoundsRaw(home, JSON.stringify({
    chains: { codex: { count: 5, last_activity: oldTs } }
  }));
  const r = runGuard(home, 'codex');
  assert.strictEqual(r.code, 0, `expired-chain call should be allowed (got code ${r.code}, stderr: ${r.stderr})`);
  // After the call, count should be 1 (fresh chain).
  const state = readRounds(home);
  assert.strictEqual(state.chains.codex.count, 1, `counter should reset to 1, got ${state.chains.codex.count}`);
});

test('chain still active (TTL not expired): counter is preserved, blocks at cap', (home) => {
  writeConfig(home, { max_rounds: 5, ttl_minutes: 30, hard_block: true });
  // Pre-seed: codex chain at the cap, last_activity 5 min ago (well within TTL).
  const recentTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  writeRoundsRaw(home, JSON.stringify({
    chains: { codex: { count: 5, last_activity: recentTs } }
  }));
  const r = runGuard(home, 'codex');
  assert.strictEqual(r.code, 2, `active-chain at cap should block (got code ${r.code})`);
});

test('per-target isolation: codex at cap does NOT block gemini', (home) => {
  writeConfig(home, { max_rounds: 5, ttl_minutes: 30, hard_block: true });
  const recentTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  writeRoundsRaw(home, JSON.stringify({
    chains: { codex: { count: 5, last_activity: recentTs } }
  }));
  const rCodex = runGuard(home, 'codex');
  assert.strictEqual(rCodex.code, 2, 'codex should be blocked');
  const rGemini = runGuard(home, 'gemini');
  assert.strictEqual(rGemini.code, 0, `gemini should still be allowed (got code ${rGemini.code}, stderr: ${rGemini.stderr})`);
});

test('per-target TTL isolation: codex chain expires while gemini chain is still fresh', (home) => {
  writeConfig(home, { max_rounds: 5, ttl_minutes: 30, hard_block: true });
  const oldTs = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  const recentTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  writeRoundsRaw(home, JSON.stringify({
    chains: {
      codex:  { count: 5, last_activity: oldTs },     // expired
      gemini: { count: 4, last_activity: recentTs },  // still active
    }
  }));
  // Hitting codex should reset codex (TTL expired) AND preserve gemini state.
  runGuard(home, 'codex');
  const state = readRounds(home);
  assert.strictEqual(state.chains.codex.count, 1, 'codex should be reset to 1');
  assert.strictEqual(state.chains.gemini.count, 4, `gemini count should be preserved at 4, got ${state.chains.gemini.count}`);
  assert.strictEqual(state.chains.gemini.last_activity, recentTs, 'gemini last_activity should be preserved');
});

test('legacy rounds.json shape is migrated on read', (home) => {
  writeConfig(home, { max_rounds: 5, ttl_minutes: 30, hard_block: true });
  // Legacy shape (v0.2.0): single global last_activity, recent so it doesn't expire.
  const recentTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  writeRoundsRaw(home, JSON.stringify({
    last_activity: recentTs,
    rounds: { codex: 2 }
  }));
  const r = runGuard(home, 'codex');
  assert.strictEqual(r.code, 0, 'migrated legacy state should still allow under the cap');
  const state = readRounds(home);
  assert.ok(state.chains, 'state should now use chains schema');
  assert.strictEqual(state.chains.codex.count, 3, 'legacy count 2 + 1 = 3');
  assert.ok(!state.rounds, 'legacy rounds key should not be re-written');
  assert.ok(!state.last_activity, 'legacy last_activity key should not be re-written');
});

test('hard_block disabled: never blocks even at cap', (home) => {
  writeConfig(home, { max_rounds: 5, ttl_minutes: 30, hard_block: false });
  const recentTs = new Date(Date.now() - 1 * 60 * 1000).toISOString();
  writeRoundsRaw(home, JSON.stringify({
    chains: { codex: { count: 100, last_activity: recentTs } }
  }));
  const r = runGuard(home, 'codex');
  assert.strictEqual(r.code, 0, 'hard_block=false should allow regardless of count');
});

test('non-peer-ai shell command is allowed without inspection', (home) => {
  writeConfig(home, { max_rounds: 5, ttl_minutes: 30, hard_block: true });
  const payload = JSON.stringify({ tool_input: { command: 'ls -la /tmp' } });
  const result = spawnSync('node', [GUARD], {
    input: payload,
    env: { ...process.env, HOME: home, PEER_AI_MAX_ROUNDS: '' },
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, 'unrelated shell command must be allowed');
});

test('PEER_AI_MAX_ROUNDS env var overrides config cap', (home) => {
  writeConfig(home, { max_rounds: 5, ttl_minutes: 30, hard_block: true });
  const recentTs = new Date(Date.now() - 1 * 60 * 1000).toISOString();
  writeRoundsRaw(home, JSON.stringify({
    chains: { codex: { count: 5, last_activity: recentTs } }
  }));
  const cmds = 'codex exec --sandbox read-only - < /tmp/brief';
  const payload = JSON.stringify({ tool_input: { command: cmds } });
  const result = spawnSync('node', [GUARD], {
    input: payload,
    env: { ...process.env, HOME: home, PEER_AI_MAX_ROUNDS: '10' },
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, 'env override should raise cap and allow the call');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
