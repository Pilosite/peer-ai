#!/usr/bin/env node
/**
 * peer-ai guard — hook handler shared by Claude Code, Codex CLI, and Gemini CLI.
 *
 * Invoked by each CLI's PreToolUse / BeforeTool hook. Reads the tool call
 * payload on stdin, decides whether the call is a peer-ai consultation (by
 * pattern-matching the Bash command), and either:
 *   - allows the call (exit 0)
 *   - blocks it (exit 2 + stderr reason) when the per-session round budget
 *     is exhausted for that target
 *
 * Configuration is resolved in this priority order:
 *   1. Environment variable PEER_AI_MAX_ROUNDS (temporary override)
 *   2. ~/.peer-ai/config.json (persistent user config)
 *   3. Hardcoded default of 5
 *
 * Round state lives in ~/.peer-ai/rounds.json. A session is considered
 * expired (auto-reset) after `ttl_minutes` of inactivity. Each successful
 * allow-decision increments the counter and refreshes last_activity.
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
  ttl_minutes: 60,
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

    const rounds = loadRounds(config.ttl_minutes);
    const current = rounds.rounds[target] || 0;
    const max = config.max_rounds;

    if (current >= max) {
      exitBlock(
        `peer-ai: consultation limit reached (${current}/${max} for ${target} in this session).\n` +
        `  To continue: run \`npx @pilosite/peer-ai@latest reset ${target}\` (or \`reset\` for all targets),\n` +
        `  or raise the cap: \`npx @pilosite/peer-ai@latest config set max_rounds ${max + 5}\`,\n` +
        `  or override just this session: \`export PEER_AI_MAX_ROUNDS=${max + 5}\`.`
      );
    }

    // Increment and persist.
    rounds.rounds[target] = current + 1;
    rounds.last_activity = new Date().toISOString();
    saveRounds(rounds);

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

function loadRounds(ttlMinutes) {
  const now = Date.now();
  const ttlMs = (ttlMinutes || DEFAULT_CONFIG.ttl_minutes) * 60 * 1000;

  if (!fs.existsSync(ROUNDS_PATH)) {
    return { last_activity: new Date().toISOString(), rounds: {} };
  }

  try {
    const raw = fs.readFileSync(ROUNDS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const lastActivityMs = new Date(parsed.last_activity || 0).getTime();

    if (now - lastActivityMs > ttlMs) {
      debug('session TTL expired, resetting counter', {
        inactive_minutes: Math.round((now - lastActivityMs) / 60000),
      });
      return { last_activity: new Date().toISOString(), rounds: {} };
    }

    return {
      last_activity: parsed.last_activity,
      rounds: parsed.rounds || {},
    };
  } catch (err) {
    debug('rounds parse error, resetting', { error: err.message });
    return { last_activity: new Date().toISOString(), rounds: {} };
  }
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
