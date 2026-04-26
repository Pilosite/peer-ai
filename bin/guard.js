#!/usr/bin/env node
/**
 * peer-ai guard — hook handler shared by Claude Code, Codex CLI, and Gemini CLI.
 *
 * Invoked by each CLI's PreToolUse / BeforeTool hook. Reads the tool call
 * payload on stdin, decides whether the call is a peer-ai consultation (by
 * pattern-matching the Bash command), and either:
 *   - allows the call (exit 0)
 *   - blocks it (exit 2 + stderr reason) when the per-chain round budget
 *     is exhausted for that target
 *
 * Configuration is resolved in this priority order:
 *   1. Environment variable PEER_AI_MAX_ROUNDS (temporary override)
 *   2. ~/.peer-ai/config.json (persistent user config)
 *   3. Hardcoded default of 5
 *
 * Round state lives in ~/.peer-ai/rounds.json. The cap is per-EXCHANGE-CHAIN,
 * not per-CLI-session: each target has its own `last_activity` timestamp, and
 * the counter for that target auto-resets after `ttl_minutes` of inactivity
 * (default 30). The intent is to prevent infinite ping-pong on a single
 * dialogue — once the back-and-forth pauses for >ttl_minutes, the next call
 * starts a fresh chain. This is independent of `/clear`, new shells, or
 * Claude/Codex/Gemini session boundaries (which the guard cannot detect).
 *
 * Debug: set PEER_AI_DEBUG=1 to log decisions to ~/.peer-ai/guard.log
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// -------- Constants --------
const PEER_AI_DIR = path.join(os.homedir(), '.peer-ai');
const CONFIG_PATH = path.join(PEER_AI_DIR, 'config.json');
const ROUNDS_PATH = path.join(PEER_AI_DIR, 'rounds.json');
const DEBUG_LOG = path.join(PEER_AI_DIR, 'guard.log');

const DEFAULT_CONFIG = {
  max_rounds: 5,
  ttl_minutes: 30,
  hard_block: true,
};

// -------- Target detection regexes --------
// A peer-ai consultation invokes one of the target CLIs in non-interactive mode
// with the flags/stdin pattern the installed skill templates use. These regexes
// must stay in sync with the invocation blocks in templates/*/peer-ai.md.tmpl.
const TARGET_PATTERNS = {
  codex: /\bcodex\s+exec\b/,
  claude: /\bclaude\s+-p\b/,
  gemini: /\bgemini\s*(?:<|--prompt|\s-p\b)/,
};

// -------- Main --------
(async () => {
  try {
    const payload = await readStdinJson();
    debug('payload received', payload);

    const command = extractCommand(payload);
    if (!command) {
      // Not a shell tool call we can inspect — allow it unconditionally.
      exitAllow('not a shell tool call');
    }

    const target = detectTarget(command);
    if (!target) {
      // Shell call but not a peer-ai target invocation — not our business.
      exitAllow(`no peer-ai target in command: ${command.slice(0, 80)}`);
    }

    const config = loadConfig();
    if (!config.hard_block) {
      exitAllow('hard_block disabled in config');
    }

    const state = loadRounds(config.ttl_minutes, target);
    const current = state.chains[target]?.count || 0;
    const max = config.max_rounds;

    if (current >= max) {
      exitBlock(
        `peer-ai: consultation limit reached (${current}/${max} for ${target} in this exchange chain).\n` +
        `  The cap is per dialogue, not per CLI session — it auto-resets after ${config.ttl_minutes} min of\n` +
        `  inactivity for this target. To continue immediately:\n` +
        `    run \`npx @pilosite/peer-ai@latest reset ${target}\` (or \`reset\` for all targets),\n` +
        `    raise the cap: \`npx @pilosite/peer-ai@latest config set max_rounds ${max + 5}\`,\n` +
        `    or override just this shell: \`export PEER_AI_MAX_ROUNDS=${max + 5}\`.`
      );
    }

    // Increment and persist (per-target chain, per-target last_activity).
    state.chains[target] = {
      count: current + 1,
      last_activity: new Date().toISOString(),
    };
    saveRounds(state);

    exitAllow(`${target} consultation ${current + 1}/${max}`);
  } catch (err) {
    // On any unexpected guard failure, fail OPEN rather than breaking the user's
    // workflow. Log to stderr so the CLI surfaces the warning, but don't block.
    process.stderr.write(`peer-ai guard error (failing open): ${err.message}\n`);
    debug('error', { message: err.message, stack: err.stack });
    process.exit(0);
  }
})();

// -------- Stdin / payload parsing --------

function readStdinJson() {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`invalid JSON on stdin: ${err.message}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

/**
 * Extract the shell command string from a hook payload. Schemas differ slightly
 * across CLIs, so we check all known locations.
 *
 * Claude Code:  { tool_input: { command: "..." } }
 * Codex CLI:    { tool_input: { command: "..." } }  (same shape)
 * Gemini CLI:   { tool_input: { command: "..." } }  (verified during install)
 *
 * Fallback: if the payload has a top-level `command` field we use it.
 */
function extractCommand(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return (
    payload?.tool_input?.command ||
    payload?.toolInput?.command ||
    payload?.input?.command ||
    payload?.command ||
    null
  );
}

function detectTarget(command) {
  if (typeof command !== 'string') return null;
  for (const [target, regex] of Object.entries(TARGET_PATTERNS)) {
    if (regex.test(command)) return target;
  }
  return null;
}

// -------- Config loading --------

function loadConfig() {
  let config = { ...DEFAULT_CONFIG };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      config = { ...config, ...fileConfig };
    } catch (err) {
      debug('config parse error, using defaults', { error: err.message });
    }
  }

  // Env var override for max_rounds (temporary session override)
  const envMax = parseInt(process.env.PEER_AI_MAX_ROUNDS || '', 10);
  if (!isNaN(envMax) && envMax > 0) {
    config.max_rounds = envMax;
  }

  return config;
}

// -------- Rounds state --------

/**
 * Load the rounds state and apply per-target TTL expiry for `target`.
 *
 * Schema (current):
 *   { "chains": { "<target>": { "count": N, "last_activity": ISO8601 }, ... } }
 *
 * Backward compat: if the file uses the legacy { rounds, last_activity } shape
 * (a single global last_activity), migrate it on read by re-using the global
 * timestamp as each target's last_activity. The migrated state is returned;
 * the next saveRounds() call writes the new shape to disk.
 *
 * Only the entry for `target` is TTL-checked here — other targets' chains are
 * preserved as-is so we don't reset, e.g., gemini's counter when a codex chain
 * times out. Each target ages independently.
 */
function loadRounds(ttlMinutes, target) {
  const now = Date.now();
  const ttlMs = (ttlMinutes || DEFAULT_CONFIG.ttl_minutes) * 60 * 1000;

  let state = { chains: {} };

  if (fs.existsSync(ROUNDS_PATH)) {
    try {
      const raw = fs.readFileSync(ROUNDS_PATH, 'utf8');
      const parsed = JSON.parse(raw);

      if (parsed && typeof parsed === 'object' && parsed.chains && typeof parsed.chains === 'object') {
        // Current schema.
        state.chains = parsed.chains;
      } else if (parsed && typeof parsed === 'object' && parsed.rounds && typeof parsed.rounds === 'object') {
        // Legacy schema: { rounds: { codex: 2 }, last_activity: "..." } — migrate.
        const legacyTs = parsed.last_activity || new Date(0).toISOString();
        for (const [t, count] of Object.entries(parsed.rounds)) {
          if (typeof count === 'number' && count > 0) {
            state.chains[t] = { count, last_activity: legacyTs };
          }
        }
        debug('migrated legacy rounds.json shape', { migrated_targets: Object.keys(state.chains) });
      }
    } catch (err) {
      debug('rounds parse error, resetting', { error: err.message });
      state = { chains: {} };
    }
  }

  // Apply TTL only to the target chain we're about to inspect — leave others alone.
  if (target && state.chains[target]) {
    const lastMs = new Date(state.chains[target].last_activity || 0).getTime();
    if (now - lastMs > ttlMs) {
      debug('chain TTL expired for target, resetting', {
        target,
        inactive_minutes: Math.round((now - lastMs) / 60000),
      });
      delete state.chains[target];
    }
  }

  return state;
}

function saveRounds(rounds) {
  fs.mkdirSync(PEER_AI_DIR, { recursive: true });
  const tmp = ROUNDS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rounds, null, 2), 'utf8');
  fs.renameSync(tmp, ROUNDS_PATH);
}

// -------- Exit helpers --------

function exitAllow(reason) {
  debug('ALLOW', { reason });
  process.exit(0);
}

function exitBlock(reason) {
  debug('BLOCK', { reason });
  process.stderr.write(reason + '\n');
  process.exit(2);
}

// -------- Debug logging --------

function debug(event, data) {
  if (!process.env.PEER_AI_DEBUG) return;
  try {
    fs.mkdirSync(PEER_AI_DIR, { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      event,
      ...(data ? { data } : {}),
    };
    fs.appendFileSync(DEBUG_LOG, JSON.stringify(entry) + '\n');
  } catch {
    // Best-effort only — never fail the guard because of logging.
  }
}
