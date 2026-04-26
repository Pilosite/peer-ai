#!/usr/bin/env node
/**
 * peer-ai installer
 *
 * Installs the peer-ai skill in Claude Code, Codex CLI, and/or Gemini CLI
 * with a target matrix picked by the user, a shared guard script for hard
 * enforcement of the per-exchange-chain consultation cap, and optional updates
 * to each CLI's instructions file (CLAUDE.md / AGENTS.md / GEMINI.md).
 *
 * Usage:
 *   npx @pilosite/peer-ai@latest                       # interactive install
 *   npx @pilosite/peer-ai@latest --local               # project-level install
 *   npx @pilosite/peer-ai@latest --global              # user-level install (default)
 *   npx @pilosite/peer-ai@latest --all                 # install everywhere detected
 *   npx @pilosite/peer-ai@latest --max-rounds 10       # raise the per-chain cap
 *   npx @pilosite/peer-ai@latest --no-hooks            # soft cap only, no hard block
 *   npx @pilosite/peer-ai@latest --uninstall           # remove peer-ai
 *   npx @pilosite/peer-ai@latest config get            # print current config
 *   npx @pilosite/peer-ai@latest config set max_rounds 10
 *   npx @pilosite/peer-ai@latest reset                 # wipe the round counter
 *   npx @pilosite/peer-ai@latest reset codex           # wipe codex only
 *   npx @pilosite/peer-ai@latest status                # show current round usage
 *
 * Zero runtime dependencies — Node core only.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { execSync } = require('child_process');

// -------- Colors --------
const cyan = '\x1b[36m';
const green = '\x1b[32m';
const yellow = '\x1b[33m';
const red = '\x1b[31m';
const dim = '\x1b[2m';
const bold = '\x1b[1m';
const reset = '\x1b[0m';

const pkg = require('../package.json');

// -------- peer-ai state paths (shared with guard.js) --------
const PEER_AI_DIR = path.join(os.homedir(), '.peer-ai');
const PEER_AI_CONFIG = path.join(PEER_AI_DIR, 'config.json');
const PEER_AI_ROUNDS = path.join(PEER_AI_DIR, 'rounds.json');
const PEER_AI_GUARD = path.join(PEER_AI_DIR, 'guard.js');

const DEFAULT_CONFIG = {
  max_rounds: 5,
  ttl_minutes: 30,
  hard_block: true,
};

// -------- Supported AIs --------
const AIS = {
  claude: {
    label: 'Claude Code',
    binary: 'claude',
    detect: () => which('claude'),
    installPath: (scope, cwd) =>
      scope === 'local'
        ? path.join(cwd, '.claude', 'commands', 'peer-ai.md')
        : path.join(os.homedir(), '.claude', 'commands', 'peer-ai.md'),
    instructionsPath: (scope, cwd) =>
      scope === 'local'
        ? path.join(cwd, 'CLAUDE.md')
        : path.join(os.homedir(), '.claude', 'CLAUDE.md'),
    hookSettingsPath: (scope, cwd) =>
      scope === 'local'
        ? path.join(cwd, '.claude', 'settings.json')
        : path.join(os.homedir(), '.claude', 'settings.json'),
    templateDir: 'claude',
    writer: writeClaudeSkill,
    hookWriter: writeClaudeHook,
    hookRemover: removeClaudeHook,
  },
  codex: {
    label: 'Codex CLI (OpenAI)',
    binary: 'codex',
    detect: () => which('codex'),
    installPath: (scope, cwd) =>
      scope === 'local'
        ? path.join(cwd, '.codex', 'skills', 'peer-ai', 'SKILL.md')
        : path.join(os.homedir(), '.codex', 'skills', 'peer-ai', 'SKILL.md'),
    instructionsPath: (scope, cwd) =>
      scope === 'local'
        ? path.join(cwd, 'AGENTS.md')
        : path.join(os.homedir(), '.codex', 'AGENTS.md'),
    hookSettingsPath: (scope, cwd) =>
      scope === 'local'
        ? path.join(cwd, '.codex', 'hooks.json')
        : path.join(os.homedir(), '.codex', 'hooks.json'),
    codexConfigPath: (scope, cwd) =>
      scope === 'local'
        ? path.join(cwd, '.codex', 'config.toml')
        : path.join(os.homedir(), '.codex', 'config.toml'),
    templateDir: 'codex',
    writer: writeCodexSkill,
    hookWriter: writeCodexHook,
    hookRemover: removeCodexHook,
  },
  gemini: {
    label: 'Gemini CLI (Google)',
    binary: 'gemini',
    detect: () => which('gemini'),
    installPath: (scope, cwd) =>
      scope === 'local'
        ? path.join(cwd, '.gemini', 'extensions', 'peer-ai')
        : path.join(os.homedir(), '.gemini', 'extensions', 'peer-ai'),
    instructionsPath: (scope, cwd) =>
      scope === 'local'
        ? path.join(cwd, 'GEMINI.md')
        : path.join(os.homedir(), '.gemini', 'GEMINI.md'),
    hookSettingsPath: (scope, cwd) =>
      scope === 'local'
        ? path.join(cwd, '.gemini', 'settings.json')
        : path.join(os.homedir(), '.gemini', 'settings.json'),
    templateDir: 'gemini',
    writer: writeGeminiExtension,
    hookWriter: writeGeminiHook,
    hookRemover: removeGeminiHook,
  },
};

// Instructions block markers
const INSTRUCTIONS_OPEN_MARKER = '<!-- peer-ai Configuration — managed by peer-ai installer';
const INSTRUCTIONS_CLOSE_MARKER = '<!-- /peer-ai Configuration -->';

// Hook signature — stable marker so we can detect and cleanly remove our hook
// entries without touching other hooks a user may have configured.
const HOOK_MARKER_COMMAND_SUFFIX = '.peer-ai/guard.js';

// -------- Args parsing --------
const argv = process.argv.slice(2);
const args = argv.filter((a) => !a.startsWith('-') || a === '-g' || a === '-l' || a === '-u' || a === '-v' || a === '-h' || a === '-y');

// Detect subcommand (first positional arg that isn't a flag, excluding our short flags)
const positional = argv.filter((a) => !a.startsWith('-'));
const subcommand = positional[0] && ['config', 'reset', 'status'].includes(positional[0]) ? positional[0] : null;

const hasGlobal = argv.includes('--global') || argv.includes('-g');
const hasLocal = argv.includes('--local') || argv.includes('-l');
const hasAll = argv.includes('--all');
const hasUninstall = argv.includes('--uninstall') || argv.includes('-u');
const hasVersion = argv.includes('--version') || argv.includes('-v');
const hasHelp = argv.includes('--help') || argv.includes('-h');
const hasYes = argv.includes('--yes') || argv.includes('-y');
const hasClaude = argv.includes('--claude');
const hasCodex = argv.includes('--codex');
const hasGemini = argv.includes('--gemini');
const hasNoInstructions = argv.includes('--no-instructions');
const hasInstructions = argv.includes('--instructions');
const hasNoHooks = argv.includes('--no-hooks');
const hasHooks = argv.includes('--hooks');

// --max-rounds N (value is the next argv item)
const maxRoundsIdx = argv.indexOf('--max-rounds');
const cliMaxRounds = maxRoundsIdx >= 0 ? parseInt(argv[maxRoundsIdx + 1] || '', 10) : null;

// -------- Main --------
(async () => {
  if (hasVersion) {
    console.log(`peer-ai v${pkg.version}`);
    process.exit(0);
  }

  if (hasHelp) {
    printHelp();
    process.exit(0);
  }

  // Subcommands have their own flow — no install banner
  if (subcommand === 'config') {
    await runConfig(positional.slice(1));
    process.exit(0);
  }
  if (subcommand === 'reset') {
    await runReset(positional.slice(1));
    process.exit(0);
  }
  if (subcommand === 'status') {
    await runStatus();
    process.exit(0);
  }

  printBanner();

  if (hasUninstall) {
    await runUninstall();
    process.exit(0);
  }

  await runInstall();
})().catch((err) => {
  console.error(`${red}${bold}Fatal error:${reset} ${err.message}`);
  if (process.env.PEER_AI_DEBUG) {
    console.error(err.stack);
  }
  process.exit(1);
});

// -------- Install flow --------
async function runInstall() {
  // Step 1: Detect installed AIs
  const detected = {};
  for (const [key, ai] of Object.entries(AIS)) {
    detected[key] = ai.detect();
  }
  const installedList = Object.keys(detected).filter((k) => detected[k]);

  console.log(`${bold}Detected AI CLIs on this machine:${reset}`);
  for (const key of Object.keys(AIS)) {
    const ai = AIS[key];
    if (detected[key]) {
      console.log(`  ${green}✓${reset} ${ai.label.padEnd(22)} ${dim}${detected[key]}${reset}`);
    } else {
      console.log(`  ${dim}✗ ${ai.label.padEnd(22)} (not installed)${reset}`);
    }
  }
  console.log();

  if (installedList.length === 0) {
    console.log(`${red}No supported AI CLIs detected.${reset}`);
    console.log(`Install at least one of: claude, codex, gemini.`);
    process.exit(1);
  }

  // Step 2: Determine scope (global vs local)
  let scope;
  if (hasLocal) {
    scope = 'local';
  } else if (hasGlobal) {
    scope = 'global';
  } else if (hasYes || hasAll) {
    scope = 'global';
  } else {
    scope = await askScope();
  }
  const cwd = process.cwd();
  console.log(`${bold}Install scope:${reset} ${scope === 'local' ? `local (${cwd})` : `global (${os.homedir()})`}\n`);

  // Step 3: Determine sources (which AIs should have the skill installed)
  let sources;
  if (hasAll) {
    sources = installedList;
  } else {
    const flagged = [];
    if (hasClaude && detected.claude) flagged.push('claude');
    if (hasCodex && detected.codex) flagged.push('codex');
    if (hasGemini && detected.gemini) flagged.push('gemini');
    if (flagged.length > 0) {
      sources = flagged;
    } else {
      sources = await askSources(installedList);
    }
  }

  if (sources.length === 0) {
    console.log(`${yellow}No sources selected. Nothing to install.${reset}`);
    process.exit(0);
  }

  // Step 4: For each source, determine targets
  const sourceTargets = {};
  for (const src of sources) {
    const candidates = installedList.filter((k) => k !== src);
    if (hasAll || hasYes) {
      sourceTargets[src] = candidates;
    } else {
      sourceTargets[src] = await askTargets(src, candidates);
    }
  }

  // Step 5: Determine max_rounds (config value that will be written to ~/.peer-ai/config.json)
  let maxRounds;
  if (cliMaxRounds && cliMaxRounds > 0) {
    maxRounds = cliMaxRounds;
  } else if (hasYes || hasAll) {
    maxRounds = DEFAULT_CONFIG.max_rounds;
  } else {
    maxRounds = await askMaxRounds();
  }

  // Step 6: Determine whether to install hooks (hard-block) or stay soft-only
  let installHooks;
  if (hasNoHooks) {
    installHooks = false;
  } else if (hasHooks || hasYes || hasAll) {
    installHooks = true;
  } else {
    console.log();
    console.log(`${bold}Enable hard-block hooks?${reset}`);
    console.log(`Hooks install a shared guard script in each CLI that hard-blocks`);
    console.log(`peer-ai calls once the per-chain cap is reached. Without hooks,`);
    console.log(`the cap is enforced only by a soft instruction inside each skill.`);
    installHooks = await askYesNo('Install hard-block hooks?', true);
  }

  // Step 7: Preview plan
  console.log();
  console.log(`${bold}Install plan:${reset}`);
  console.log(`  ${dim}max_rounds:${reset} ${maxRounds} per target per exchange chain`);
  console.log(`  ${dim}hard block:${reset} ${installHooks ? 'yes (hooks)' : 'no (soft cap only)'}`);
  console.log();
  for (const src of sources) {
    const ai = AIS[src];
    const tgts = sourceTargets[src];
    const tgtLabels = tgts.length > 0 ? tgts.map((t) => AIS[t].label).join(', ') : `${dim}(no targets — will only expose /list)${reset}`;
    const installPath = ai.installPath(scope, cwd);
    console.log(`  ${cyan}${ai.label}${reset}`);
    console.log(`    skill:   ${dim}${installPath}${reset}`);
    console.log(`    targets: ${tgtLabels}`);
    if (installHooks) {
      console.log(`    hook:    ${dim}${ai.hookSettingsPath(scope, cwd)}${reset}`);
    }
  }
  console.log();

  // Step 8: Confirm
  if (!hasYes && !hasAll) {
    const confirmed = await askYesNo('Proceed with install?', true);
    if (!confirmed) {
      console.log(`${yellow}Install cancelled.${reset}`);
      process.exit(0);
    }
  }

  // Step 9: Write skill files
  let successCount = 0;
  for (const src of sources) {
    const ai = AIS[src];
    const tgts = sourceTargets[src];
    try {
      const installPath = ai.installPath(scope, cwd);
      ai.writer({ installPath, targets: tgts, version: pkg.version, maxRounds });
      console.log(`${green}✓${reset} Installed ${ai.label} skill -> ${dim}${installPath}${reset}`);
      successCount++;
    } catch (err) {
      console.error(`${red}✗${reset} Failed to install ${ai.label}: ${err.message}`);
    }
  }

  // Step 10: Install hooks + guard script + config file
  if (installHooks) {
    console.log();
    try {
      writePeerAiConfig({ max_rounds: maxRounds });
      copyGuardScript();
      console.log(`${green}✓${reset} Installed guard + config at ${dim}${PEER_AI_DIR}${reset}`);
    } catch (err) {
      console.error(`${red}✗${reset} Failed to install guard/config: ${err.message}`);
    }

    for (const src of sources) {
      const ai = AIS[src];
      try {
        const result = ai.hookWriter({ scope, cwd });
        if (result === 'needs_codex_flag') {
          console.log(`${yellow}⚠${reset} Codex hook installed, but requires feature flag to take effect:`);
          console.log(`    ${dim}Add \`codex_hooks = true\` under [features] in ~/.codex/config.toml${reset}`);
          const shouldFlip = (hasYes || hasAll) ? true : await askYesNo('  Enable codex_hooks = true now?', true);
          if (shouldFlip) {
            enableCodexHooksFlag(scope, cwd);
            console.log(`${green}  ✓${reset} Enabled codex_hooks feature flag`);
          } else {
            console.log(`${dim}  → Remember to enable it later, or hooks will have no effect.${reset}`);
          }
        } else if (result === 'gemini_warning') {
          console.log(`${green}✓${reset} Installed ${ai.label} hook -> ${dim}${ai.hookSettingsPath(scope, cwd)}${reset}`);
          console.log(`${dim}  First invocation may show a Gemini security fingerprint warning — this is${reset}`);
          console.log(`${dim}  expected. Accept it to authorize peer-ai's guard script.${reset}`);
        } else {
          console.log(`${green}✓${reset} Installed ${ai.label} hook -> ${dim}${ai.hookSettingsPath(scope, cwd)}${reset}`);
        }
      } catch (err) {
        console.error(`${yellow}⚠${reset} Could not install ${ai.label} hook: ${err.message}`);
      }
    }
  }

  // Step 11: Optionally update instructions files
  let shouldUpdateInstructions;
  if (hasNoInstructions) {
    shouldUpdateInstructions = false;
  } else if (hasInstructions || hasAll || hasYes) {
    shouldUpdateInstructions = true;
  } else {
    console.log();
    console.log(`${bold}Update instructions files?${reset}`);
    console.log(`peer-ai can add a short section to your instructions files so the model`);
    console.log(`knows the skill exists and when to use it. Files affected:`);
    for (const src of sources) {
      const p = AIS[src].instructionsPath(scope, cwd);
      const exists = fs.existsSync(p) ? `${dim}(exists — will add block if missing)${reset}` : `${dim}(will create)${reset}`;
      console.log(`  - ${p} ${exists}`);
    }
    shouldUpdateInstructions = await askYesNo('Update instructions files?', true);
  }

  if (shouldUpdateInstructions) {
    console.log();
    for (const src of sources) {
      const ai = AIS[src];
      const tgts = sourceTargets[src];
      const instructionsPath = ai.instructionsPath(scope, cwd);
      try {
        const result = updateInstructions({
          filePath: instructionsPath,
          targets: tgts,
          version: pkg.version,
          maxRounds,
        });
        if (result === 'created') {
          console.log(`${green}✓${reset} Created ${dim}${instructionsPath}${reset}`);
        } else if (result === 'updated') {
          console.log(`${green}✓${reset} Updated ${dim}${instructionsPath}${reset}`);
        } else if (result === 'added') {
          console.log(`${green}✓${reset} Added peer-ai block to ${dim}${instructionsPath}${reset}`);
        }
      } catch (err) {
        console.error(`${yellow}⚠${reset} Could not update ${instructionsPath}: ${err.message}`);
      }
    }
  }

  console.log();
  if (successCount === sources.length) {
    console.log(`${green}${bold}✓ peer-ai installed successfully (${successCount} source${successCount > 1 ? 's' : ''})${reset}`);
    console.log();
    printUsageHint(sources, maxRounds);
  } else {
    console.log(`${yellow}⚠ Partial install: ${successCount}/${sources.length} sources${reset}`);
    process.exit(2);
  }
}

// -------- Uninstall flow --------
async function runUninstall() {
  const scope = hasLocal ? 'local' : 'global';
  const cwd = process.cwd();

  console.log(`${bold}Uninstalling peer-ai (${scope})${reset}\n`);

  let removed = 0;
  let blocksRemoved = 0;
  let hooksRemoved = 0;

  for (const [key, ai] of Object.entries(AIS)) {
    // Remove skill
    const installPath = ai.installPath(scope, cwd);
    if (fs.existsSync(installPath)) {
      try {
        if (fs.statSync(installPath).isDirectory()) {
          fs.rmSync(installPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(installPath);
          const parent = path.dirname(installPath);
          if (path.basename(parent) === 'peer-ai') {
            try { fs.rmdirSync(parent); } catch {}
          }
        }
        console.log(`${green}✓${reset} Removed ${ai.label} skill: ${dim}${installPath}${reset}`);
        removed++;
      } catch (err) {
        console.error(`${red}✗${reset} Failed to remove ${ai.label} skill: ${err.message}`);
      }
    }

    // Remove instructions block
    if (!hasNoInstructions) {
      const instructionsPath = ai.instructionsPath(scope, cwd);
      if (fs.existsSync(instructionsPath)) {
        try {
          const stripped = removeInstructionsBlock(instructionsPath);
          if (stripped) {
            console.log(`${green}✓${reset} Removed peer-ai block from ${dim}${instructionsPath}${reset}`);
            blocksRemoved++;
          }
        } catch (err) {
          console.error(`${yellow}⚠${reset} Could not strip block from ${instructionsPath}: ${err.message}`);
        }
      }
    }

    // Remove hook entry
    try {
      const removedHook = ai.hookRemover({ scope, cwd });
      if (removedHook) {
        console.log(`${green}✓${reset} Removed ${ai.label} hook: ${dim}${ai.hookSettingsPath(scope, cwd)}${reset}`);
        hooksRemoved++;
      }
    } catch (err) {
      console.error(`${yellow}⚠${reset} Could not strip hook from ${ai.label}: ${err.message}`);
    }
  }

  // Remove ~/.peer-ai/ directory entirely at global scope
  if (scope === 'global' && fs.existsSync(PEER_AI_DIR)) {
    try {
      fs.rmSync(PEER_AI_DIR, { recursive: true, force: true });
      console.log(`${green}✓${reset} Removed ${dim}${PEER_AI_DIR}${reset}`);
    } catch (err) {
      console.error(`${yellow}⚠${reset} Could not remove ${PEER_AI_DIR}: ${err.message}`);
    }
  }

  const total = removed + blocksRemoved + hooksRemoved;
  if (total === 0) {
    console.log(`${dim}Nothing to remove at ${scope} scope.${reset}`);
  } else {
    const parts = [];
    if (removed > 0) parts.push(`${removed} skill${removed > 1 ? 's' : ''}`);
    if (blocksRemoved > 0) parts.push(`${blocksRemoved} instructions block${blocksRemoved > 1 ? 's' : ''}`);
    if (hooksRemoved > 0) parts.push(`${hooksRemoved} hook${hooksRemoved > 1 ? 's' : ''}`);
    console.log(`\n${green}✓ Uninstalled peer-ai (${parts.join(', ')}).${reset}`);
  }
}

// -------- Subcommand: config --------
async function runConfig(subArgs) {
  const action = subArgs[0] || 'get';

  if (action === 'get') {
    const key = subArgs[1];
    const config = loadPeerAiConfig();
    if (key) {
      if (key in config) {
        console.log(config[key]);
      } else {
        console.error(`${red}Unknown config key: ${key}${reset}`);
        console.error(`Valid keys: ${Object.keys(DEFAULT_CONFIG).join(', ')}`);
        process.exit(1);
      }
    } else {
      console.log(`${bold}peer-ai config${reset} ${dim}(${PEER_AI_CONFIG})${reset}`);
      for (const [k, v] of Object.entries(config)) {
        console.log(`  ${k}: ${v}`);
      }
    }
    return;
  }

  if (action === 'set') {
    const key = subArgs[1];
    const rawValue = subArgs[2];
    if (!key || rawValue === undefined) {
      console.error(`${red}Usage: peer-ai config set <key> <value>${reset}`);
      process.exit(1);
    }
    if (!(key in DEFAULT_CONFIG)) {
      console.error(`${red}Unknown config key: ${key}${reset}`);
      console.error(`Valid keys: ${Object.keys(DEFAULT_CONFIG).join(', ')}`);
      process.exit(1);
    }
    const config = loadPeerAiConfig();
    // Coerce value to the same type as the default
    const defaultVal = DEFAULT_CONFIG[key];
    let value;
    if (typeof defaultVal === 'number') {
      value = parseInt(rawValue, 10);
      if (isNaN(value) || value < 0) {
        console.error(`${red}Invalid number: ${rawValue}${reset}`);
        process.exit(1);
      }
    } else if (typeof defaultVal === 'boolean') {
      value = rawValue === 'true' || rawValue === '1' || rawValue === 'yes';
    } else {
      value = rawValue;
    }
    config[key] = value;
    writePeerAiConfig(config);
    console.log(`${green}✓${reset} Set ${bold}${key}${reset} = ${value}`);
    return;
  }

  if (action === 'reset') {
    writePeerAiConfig({ ...DEFAULT_CONFIG });
    console.log(`${green}✓${reset} Reset config to defaults`);
    for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
      console.log(`  ${k}: ${v}`);
    }
    return;
  }

  console.error(`${red}Unknown config action: ${action}${reset}`);
  console.error(`Usage: peer-ai config [get|set|reset] [key] [value]`);
  process.exit(1);
}

// -------- Subcommand: reset --------
async function runReset(subArgs) {
  const target = subArgs[0];

  if (!fs.existsSync(PEER_AI_ROUNDS)) {
    console.log(`${dim}No round counter to reset.${reset}`);
    return;
  }

  if (target) {
    const state = loadRounds();
    if (!(target in (state.chains || {}))) {
      console.log(`${dim}No chain entry for "${target}". Nothing to reset.${reset}`);
      return;
    }
    delete state.chains[target];
    writeRounds(state);
    console.log(`${green}✓${reset} Reset chain counter for ${bold}${target}${reset}`);
  } else {
    writeRounds({ chains: {} });
    console.log(`${green}✓${reset} Reset all chain counters`);
  }
}

// -------- Subcommand: status --------
async function runStatus() {
  const config = loadPeerAiConfig();
  const state = fs.existsSync(PEER_AI_ROUNDS) ? loadRounds() : { chains: {} };

  console.log(`${bold}peer-ai status${reset}`);
  console.log();
  console.log(`${dim}config:${reset}`);
  console.log(`  max_rounds:  ${config.max_rounds}${process.env.PEER_AI_MAX_ROUNDS ? ` ${yellow}(overridden by PEER_AI_MAX_ROUNDS=${process.env.PEER_AI_MAX_ROUNDS})${reset}` : ''}`);
  console.log(`  ttl_minutes: ${config.ttl_minutes} ${dim}(per-target chain inactivity before auto-reset)${reset}`);
  console.log(`  hard_block:  ${config.hard_block}`);
  console.log();
  console.log(`${dim}chains (per-target — each ages independently):${reset}`);
  const effectiveMax = parseInt(process.env.PEER_AI_MAX_ROUNDS || '', 10) || config.max_rounds;
  const targets = ['claude', 'codex', 'gemini'];
  const now = Date.now();
  for (const t of targets) {
    const entry = state.chains[t];
    const used = entry?.count || 0;
    const bar = used >= effectiveMax ? `${red}BLOCKED${reset}` : used > 0 ? `${yellow}${used}/${effectiveMax}${reset}` : `${dim}${used}/${effectiveMax}${reset}`;
    let suffix = '';
    if (entry?.last_activity) {
      const age = Math.round((now - new Date(entry.last_activity).getTime()) / 60000);
      const remaining = config.ttl_minutes - age;
      if (remaining > 0) {
        suffix = ` ${dim}(active, auto-reset in ${remaining}min)${reset}`;
      } else {
        suffix = ` ${dim}(TTL expired, next call auto-resets)${reset}`;
      }
    }
    console.log(`  ${t.padEnd(8)} ${bar}${suffix}`);
  }
}

// -------- peer-ai config/rounds helpers --------
function loadPeerAiConfig() {
  if (!fs.existsSync(PEER_AI_CONFIG)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(PEER_AI_CONFIG, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writePeerAiConfig(patch) {
  fs.mkdirSync(PEER_AI_DIR, { recursive: true });
  const current = loadPeerAiConfig();
  const next = { ...current, ...patch };
  fs.writeFileSync(PEER_AI_CONFIG, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

// Load rounds state. Handles both the current per-target chain schema
// ({ chains: { codex: { count, last_activity }, ... } }) and the legacy
// ({ rounds: { codex: 2 }, last_activity: "..." }) shape — legacy data is
// migrated in-memory; the next writeRounds() persists the new shape.
function loadRounds() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PEER_AI_ROUNDS, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.chains && typeof parsed.chains === 'object') {
      return { chains: parsed.chains };
    }
    if (parsed && typeof parsed === 'object' && parsed.rounds && typeof parsed.rounds === 'object') {
      const legacyTs = parsed.last_activity || new Date(0).toISOString();
      const chains = {};
      for (const [t, count] of Object.entries(parsed.rounds)) {
        if (typeof count === 'number' && count > 0) {
          chains[t] = { count, last_activity: legacyTs };
        }
      }
      return { chains };
    }
    return { chains: {} };
  } catch {
    return { chains: {} };
  }
}

function writeRounds(state) {
  fs.mkdirSync(PEER_AI_DIR, { recursive: true });
  fs.writeFileSync(PEER_AI_ROUNDS, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function copyGuardScript() {
  const src = path.join(__dirname, 'guard.js');
  if (!fs.existsSync(src)) {
    throw new Error(`guard.js not found at ${src} — package may be corrupted`);
  }
  fs.mkdirSync(PEER_AI_DIR, { recursive: true });
  fs.copyFileSync(src, PEER_AI_GUARD);
  fs.chmodSync(PEER_AI_GUARD, 0o755);
}

// -------- Instructions file helpers --------
function updateInstructions({ filePath, targets, version, maxRounds }) {
  const blockTemplate = readTemplate('instructions-block.md.tmpl');
  const block = renderTemplate(blockTemplate, { targets, version, maxRounds });

  if (!fs.existsSync(filePath)) {
    writeFileAtomic(filePath, block);
    return 'created';
  }

  const existing = fs.readFileSync(filePath, 'utf8');
  const openIdx = existing.indexOf(INSTRUCTIONS_OPEN_MARKER);
  const closeIdx = existing.indexOf(INSTRUCTIONS_CLOSE_MARKER);

  if (openIdx >= 0 && closeIdx > openIdx) {
    const before = existing.slice(0, openIdx);
    const after = existing.slice(closeIdx + INSTRUCTIONS_CLOSE_MARKER.length);
    const updated = before + block.trimEnd() + after;
    if (updated === existing) return 'unchanged';
    fs.writeFileSync(filePath, updated, 'utf8');
    return 'updated';
  }

  const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(filePath, existing + separator + block, 'utf8');
  return 'added';
}

function removeInstructionsBlock(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const existing = fs.readFileSync(filePath, 'utf8');
  const openIdx = existing.indexOf(INSTRUCTIONS_OPEN_MARKER);
  const closeIdx = existing.indexOf(INSTRUCTIONS_CLOSE_MARKER);
  if (openIdx < 0 || closeIdx <= openIdx) return false;

  const before = existing.slice(0, openIdx).replace(/\n+$/, '');
  const after = existing.slice(closeIdx + INSTRUCTIONS_CLOSE_MARKER.length).replace(/^\n+/, '');
  let cleaned;
  if (before && after) {
    cleaned = before + '\n\n' + after;
  } else if (before) {
    cleaned = before + '\n';
  } else if (after) {
    cleaned = after;
  } else {
    fs.unlinkSync(filePath);
    return true;
  }
  fs.writeFileSync(filePath, cleaned, 'utf8');
  return true;
}

// -------- Skill writers --------
function writeClaudeSkill({ installPath, targets, version, maxRounds }) {
  const template = readTemplate('claude/peer-ai.md.tmpl');
  const rendered = renderTemplate(template, { targets, version, maxRounds });
  writeFileAtomic(installPath, rendered);
}

function writeCodexSkill({ installPath, targets, version, maxRounds }) {
  const template = readTemplate('codex/SKILL.md.tmpl');
  const rendered = renderTemplate(template, { targets, version, maxRounds });
  writeFileAtomic(installPath, rendered);
}

function writeGeminiExtension({ installPath, targets, version, maxRounds }) {
  const extJson = readTemplate('gemini/gemini-extension.json.tmpl');
  writeFileAtomic(
    path.join(installPath, 'gemini-extension.json'),
    renderTemplate(extJson, { targets, version, maxRounds }),
  );

  const listTmpl = readTemplate('gemini/commands/list.toml.tmpl');
  writeFileAtomic(
    path.join(installPath, 'commands', 'list.toml'),
    renderTemplate(listTmpl, { targets, version, maxRounds }),
  );

  for (const target of targets) {
    const templatePath = `gemini/commands/${target}.toml.tmpl`;
    if (!templateExists(templatePath)) {
      console.warn(`${yellow}⚠${reset} No Gemini template for target "${target}", skipping`);
      continue;
    }
    const tmpl = readTemplate(templatePath);
    writeFileAtomic(
      path.join(installPath, 'commands', `${target}.toml`),
      renderTemplate(tmpl, { targets, version, maxRounds }),
    );
  }
}

// -------- Hook writers --------
// Each writer edits the CLI's settings file to register PEER_AI_GUARD as a
// PreToolUse / BeforeTool hook on the shell tool. They are idempotent: running
// the installer twice does not duplicate entries.

function writeClaudeHook({ scope, cwd }) {
  const file = AIS.claude.hookSettingsPath(scope, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const settings = readJsonSafe(file);
  settings.hooks = settings.hooks || {};
  settings.hooks.PreToolUse = upsertHookMatcher(settings.hooks.PreToolUse || [], 'Bash', PEER_AI_GUARD);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return 'ok';
}

function removeClaudeHook({ scope, cwd }) {
  const file = AIS.claude.hookSettingsPath(scope, cwd);
  if (!fs.existsSync(file)) return false;
  const settings = readJsonSafe(file);
  if (!settings.hooks || !settings.hooks.PreToolUse) return false;
  const before = JSON.stringify(settings.hooks.PreToolUse);
  settings.hooks.PreToolUse = removeHookMatcher(settings.hooks.PreToolUse, 'Bash');
  const after = JSON.stringify(settings.hooks.PreToolUse);
  if (before === after) return false;
  if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return true;
}

function writeCodexHook({ scope, cwd }) {
  const file = AIS.codex.hookSettingsPath(scope, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const settings = readJsonSafe(file);
  settings.hooks = settings.hooks || {};
  settings.hooks.PreToolUse = upsertHookMatcher(settings.hooks.PreToolUse || [], 'Bash', PEER_AI_GUARD);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');

  // Check codex_hooks feature flag
  const configPath = AIS.codex.codexConfigPath(scope, cwd);
  if (!codexHooksEnabled(configPath)) {
    return 'needs_codex_flag';
  }
  return 'ok';
}

function removeCodexHook({ scope, cwd }) {
  const file = AIS.codex.hookSettingsPath(scope, cwd);
  if (!fs.existsSync(file)) return false;
  const settings = readJsonSafe(file);
  if (!settings.hooks || !settings.hooks.PreToolUse) return false;
  const before = JSON.stringify(settings.hooks.PreToolUse);
  settings.hooks.PreToolUse = removeHookMatcher(settings.hooks.PreToolUse, 'Bash');
  const after = JSON.stringify(settings.hooks.PreToolUse);
  if (before === after) return false;
  if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return true;
}

function writeGeminiHook({ scope, cwd }) {
  const file = AIS.gemini.hookSettingsPath(scope, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const settings = readJsonSafe(file);
  settings.hooks = settings.hooks || {};
  // Gemini uses BeforeTool + run_shell_command matcher
  settings.hooks.BeforeTool = upsertHookMatcher(settings.hooks.BeforeTool || [], 'run_shell_command', PEER_AI_GUARD);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return 'gemini_warning';
}

function removeGeminiHook({ scope, cwd }) {
  const file = AIS.gemini.hookSettingsPath(scope, cwd);
  if (!fs.existsSync(file)) return false;
  const settings = readJsonSafe(file);
  if (!settings.hooks || !settings.hooks.BeforeTool) return false;
  const before = JSON.stringify(settings.hooks.BeforeTool);
  settings.hooks.BeforeTool = removeHookMatcher(settings.hooks.BeforeTool, 'run_shell_command');
  const after = JSON.stringify(settings.hooks.BeforeTool);
  if (before === after) return false;
  if (settings.hooks.BeforeTool.length === 0) delete settings.hooks.BeforeTool;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return true;
}

// -------- Hook array helpers (shared across CLIs — same JSON schema) --------

/**
 * Insert or update the peer-ai hook entry in a hooks array for the given matcher.
 * Schema assumed:
 *   [ { matcher: "Bash", hooks: [ { type: "command", command: "..." } ] }, ... ]
 * Idempotent: if an entry with our guard command exists, it's left in place.
 */
function upsertHookMatcher(hooksArray, matcher, guardCommand) {
  const arr = Array.isArray(hooksArray) ? [...hooksArray] : [];
  let entry = arr.find((e) => e && e.matcher === matcher);
  if (!entry) {
    entry = { matcher, hooks: [] };
    arr.push(entry);
  }
  entry.hooks = entry.hooks || [];
  const existing = entry.hooks.find((h) => h && h.type === 'command' && typeof h.command === 'string' && h.command.endsWith(HOOK_MARKER_COMMAND_SUFFIX));
  if (existing) {
    existing.command = guardCommand;
  } else {
    entry.hooks.push({ type: 'command', command: guardCommand });
  }
  return arr;
}

/**
 * Remove only the peer-ai hook entry from a hooks array for the given matcher.
 * Leaves other user hooks untouched. If a matcher ends up with no hooks, the
 * matcher entry is dropped too.
 */
function removeHookMatcher(hooksArray, matcher) {
  if (!Array.isArray(hooksArray)) return hooksArray;
  return hooksArray
    .map((entry) => {
      if (!entry || entry.matcher !== matcher || !Array.isArray(entry.hooks)) return entry;
      const filtered = entry.hooks.filter(
        (h) => !(h && h.type === 'command' && typeof h.command === 'string' && h.command.endsWith(HOOK_MARKER_COMMAND_SUFFIX)),
      );
      if (filtered.length === 0) return null;
      return { ...entry, hooks: filtered };
    })
    .filter(Boolean);
}

// -------- Codex feature flag helpers --------
function codexHooksEnabled(configPath) {
  if (!fs.existsSync(configPath)) return false;
  const content = fs.readFileSync(configPath, 'utf8');
  return /(\[features\][\s\S]*?\bcodex_hooks\s*=\s*true\b)/m.test(content);
}

function enableCodexHooksFlag(scope, cwd) {
  const configPath = AIS.codex.codexConfigPath(scope, cwd);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  let content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  if (/\[features\]/.test(content)) {
    if (/\bcodex_hooks\s*=\s*false\b/.test(content)) {
      content = content.replace(/\bcodex_hooks\s*=\s*false\b/, 'codex_hooks = true');
    } else if (!/\bcodex_hooks\s*=\s*true\b/.test(content)) {
      content = content.replace(/\[features\]/, '[features]\ncodex_hooks = true');
    }
  } else {
    content = (content.endsWith('\n') ? content : content + '\n') + '\n[features]\ncodex_hooks = true\n';
  }
  fs.writeFileSync(configPath, content, 'utf8');
}

// -------- Template helpers --------
function readTemplate(relPath) {
  const full = path.join(__dirname, '..', 'templates', relPath);
  return fs.readFileSync(full, 'utf8');
}

function templateExists(relPath) {
  const full = path.join(__dirname, '..', 'templates', relPath);
  return fs.existsSync(full);
}

/**
 * Minimal template engine:
 *   {{version}}                          -> peer-ai version
 *   {{max_rounds}}                       -> configured max per exchange chain
 *   {{targets_list}}                     -> comma-separated labels
 *   {{targets_keys}}                     -> comma-separated keys
 *   {{#if_target NAME}}...{{/if_target}} -> include block only if NAME is a target
 *   {{#each_target}}...{{/each_target}}  -> repeat for each target ({{target_key}}, {{target_label}})
 */
function renderTemplate(tmpl, ctx) {
  const { targets, version, maxRounds } = ctx;
  const labels = {
    claude: 'Claude Code',
    codex: 'Codex CLI (OpenAI)',
    gemini: 'Gemini CLI (Google)',
  };

  let out = tmpl;

  out = out.replace(/\{\{#each_target\}\}([\s\S]*?)\{\{\/each_target\}\}/g, (_, block) => {
    return targets
      .map((t) =>
        block
          .replace(/\{\{target_key\}\}/g, t)
          .replace(/\{\{target_label\}\}/g, labels[t] || t),
      )
      .join('');
  });

  out = out.replace(/\{\{#if_target\s+(\w+)\}\}([\s\S]*?)\{\{\/if_target\}\}/g, (_, name, block) => {
    return targets.includes(name) ? block : '';
  });

  out = out.replace(/\{\{targets_list\}\}/g, targets.map((t) => labels[t] || t).join(', '));
  out = out.replace(/\{\{targets_keys\}\}/g, targets.join(', '));
  out = out.replace(/\{\{version\}\}/g, version);
  out = out.replace(/\{\{max_rounds\}\}/g, String(maxRounds ?? DEFAULT_CONFIG.max_rounds));

  return out;
}

// -------- File helpers --------
function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// -------- Detection --------
function which(binary) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execSync(`${cmd} ${binary}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .split('\n')[0];
    return out || null;
  } catch {
    return null;
  }
}

// -------- Prompts --------
function createRl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createRl();
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function askYesNo(question, defaultYes = true) {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await ask(`${question} ${hint} `)).toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith('y');
}

async function askScope() {
  console.log(`${bold}Install scope:${reset}`);
  console.log(`  1) global — install under your home directory (${dim}~/.claude, ~/.codex, ~/.gemini${reset})`);
  console.log(`  2) local  — install under the current project (${dim}./.claude, ./.codex, ./.gemini${reset})`);
  const answer = await ask('Choose [1]: ');
  return answer === '2' ? 'local' : 'global';
}

async function askSources(installedList) {
  console.log(`${bold}Which AIs should have peer-ai installed (sources) ?${reset}`);
  console.log(`A source is an AI that can initiate a peer consultation.`);
  console.log(`Default: all detected.\n`);
  for (let i = 0; i < installedList.length; i++) {
    console.log(`  ${i + 1}) ${AIS[installedList[i]].label}`);
  }
  console.log(`  a) all`);
  const answer = (await ask(`Sources [a]: `)).toLowerCase();
  if (!answer || answer === 'a' || answer === 'all') return [...installedList];

  const picks = answer.split(/[,\s]+/).filter(Boolean);
  const selected = [];
  for (const pick of picks) {
    const idx = parseInt(pick, 10) - 1;
    if (!isNaN(idx) && idx >= 0 && idx < installedList.length) {
      selected.push(installedList[idx]);
    } else if (installedList.includes(pick)) {
      selected.push(pick);
    }
  }
  return [...new Set(selected)];
}

async function askTargets(source, candidates) {
  if (candidates.length === 0) {
    console.log(`${dim}  ${AIS[source].label}: no other AIs detected, will expose /list only${reset}`);
    return [];
  }
  console.log(`${bold}Targets for ${AIS[source].label}:${reset}`);
  console.log(`Which AIs should ${AIS[source].label} be able to consult?`);
  for (let i = 0; i < candidates.length; i++) {
    console.log(`  ${i + 1}) ${AIS[candidates[i]].label}`);
  }
  console.log(`  a) all`);
  const answer = (await ask(`Targets [a]: `)).toLowerCase();
  if (!answer || answer === 'a' || answer === 'all') return [...candidates];

  const picks = answer.split(/[,\s]+/).filter(Boolean);
  const selected = [];
  for (const pick of picks) {
    const idx = parseInt(pick, 10) - 1;
    if (!isNaN(idx) && idx >= 0 && idx < candidates.length) {
      selected.push(candidates[idx]);
    } else if (candidates.includes(pick)) {
      selected.push(pick);
    }
  }
  return [...new Set(selected)];
}

async function askMaxRounds() {
  console.log();
  console.log(`${bold}Max peer consultations per target per exchange chain?${reset}`);
  console.log(`peer-ai caps AI-to-AI ping-pong loops. Default is 5 per target per chain`);
  console.log(`(a chain auto-resets after ${DEFAULT_CONFIG.ttl_minutes}min of inactivity for that target).`);
  console.log(`${dim}You can change this later with \`peer-ai config set max_rounds N\` or temporarily${reset}`);
  console.log(`${dim}via \`export PEER_AI_MAX_ROUNDS=N\`.${reset}`);
  const answer = await ask(`Max rounds [${DEFAULT_CONFIG.max_rounds}]: `);
  if (!answer) return DEFAULT_CONFIG.max_rounds;
  const n = parseInt(answer, 10);
  if (isNaN(n) || n < 1) {
    console.log(`${yellow}Invalid value, using default ${DEFAULT_CONFIG.max_rounds}.${reset}`);
    return DEFAULT_CONFIG.max_rounds;
  }
  return n;
}

// -------- Output --------
function printBanner() {
  console.log();
  console.log(`${cyan}${bold}peer-ai${reset} ${dim}v${pkg.version}${reset}  ${dim}— AI-to-AI peer consultation${reset}`);
  console.log();
}

function printHelp() {
  console.log(`${bold}peer-ai${reset} v${pkg.version}

Install the peer-ai skill in Claude Code, Codex CLI, and/or Gemini CLI so any
installed AI can ask any other installed AI for a second opinion, code review,
or deep analysis.

${bold}USAGE${reset}
  npx @pilosite/peer-ai@latest [OPTIONS]               # install
  npx @pilosite/peer-ai@latest config get [KEY]        # print config
  npx @pilosite/peer-ai@latest config set KEY VALUE    # update config
  npx @pilosite/peer-ai@latest config reset            # reset config to defaults
  npx @pilosite/peer-ai@latest reset [TARGET]          # reset round counter (all or one target)
  npx @pilosite/peer-ai@latest status                  # show current round usage

${bold}SCOPE${reset}
  -g, --global           Install under your home directory (default)
  -l, --local            Install under the current project

${bold}SOURCES${reset}
      --claude           Install peer-ai in Claude Code (must be detected)
      --codex            Install peer-ai in Codex CLI
      --gemini           Install peer-ai in Gemini CLI
      --all              Install in all detected sources

${bold}CAP ENFORCEMENT${reset}
      --max-rounds N     Configure the per-chain cap (default: 5)
      --hooks            Install hard-block hooks (interactive default)
      --no-hooks         Skip hard-block hooks (soft cap only)

${bold}INSTRUCTIONS FILES${reset}
      --instructions     Add/update peer-ai block in CLAUDE.md / AGENTS.md / GEMINI.md
      --no-instructions  Skip instructions-file updates entirely

${bold}OTHER${reset}
  -y, --yes              Skip confirmation prompts, accept all defaults
  -u, --uninstall        Remove peer-ai from the scope
  -v, --version          Print version
  -h, --help             Print this help

${bold}CONFIG KEYS${reset}
  max_rounds    Integer. Per-target-per-chain cap. Default: 5
  ttl_minutes   Integer. Per-target inactivity (minutes) before a chain auto-resets. Default: 30
  hard_block    Boolean. Whether hooks actually block (vs observe only). Default: true

${bold}ENVIRONMENT${reset}
  PEER_AI_MAX_ROUNDS     Temporary override of max_rounds for the current shell.
  PEER_AI_DEBUG          Enable guard debug logging to ~/.peer-ai/guard.log

${bold}EXAMPLES${reset}
  npx @pilosite/peer-ai@latest                            # interactive install
  npx @pilosite/peer-ai@latest --all --yes                # everywhere, no prompts
  npx @pilosite/peer-ai@latest --max-rounds 10 --all -y   # raise cap on install
  npx @pilosite/peer-ai@latest --local --claude           # project-local, Claude only
  npx @pilosite/peer-ai@latest config set max_rounds 10   # bump cap later
  npx @pilosite/peer-ai@latest reset codex                # reset codex counter
  npx @pilosite/peer-ai@latest status                     # check state
  npx @pilosite/peer-ai@latest --uninstall                # remove

${bold}DOCS${reset}
  https://github.com/Pilosite/peer-ai
`);
}

function printUsageHint(sources, maxRounds) {
  console.log(`${bold}Usage${reset}`);
  for (const src of sources) {
    if (src === 'claude') {
      console.log(`  ${cyan}Claude Code:${reset}   /peer-ai codex review the last 2 commits`);
    } else if (src === 'codex') {
      console.log(`  ${cyan}Codex:${reset}         (auto-invoked on phrases like "ask claude", "demande à gemini")`);
    } else if (src === 'gemini') {
      console.log(`  ${cyan}Gemini:${reset}        /peer-ai:codex review the architecture`);
      console.log(`                  /peer-ai:claude second opinion on this approach`);
      console.log(`                  /peer-ai:list`);
    }
  }
  console.log();
  console.log(`${bold}Cap:${reset} ${maxRounds} consultations per target per exchange chain (auto-resets after inactivity)`);
  console.log(`  ${dim}Change permanently:${reset}  npx @pilosite/peer-ai@latest config set max_rounds N`);
  console.log(`  ${dim}Override this shell:${reset} export PEER_AI_MAX_ROUNDS=N`);
  console.log(`  ${dim}Check status:${reset}        npx @pilosite/peer-ai@latest status`);
  console.log(`  ${dim}Reset counter:${reset}       npx @pilosite/peer-ai@latest reset [target]`);
  console.log();
}
