#!/usr/bin/env node
/**
 * peer-ai installer
 *
 * Installs the peer-ai skill in Claude Code, Codex CLI, and/or Gemini CLI
 * with a target matrix picked by the user (which AIs each source can call).
 *
 * Usage:
 *   npx @pilosite/peer-ai@latest              # interactive, user-level
 *   npx @pilosite/peer-ai@latest --local      # interactive, project-level
 *   npx @pilosite/peer-ai@latest --global     # interactive, user-level (explicit)
 *   npx @pilosite/peer-ai@latest --all        # install everywhere auto-detected
 *   npx @pilosite/peer-ai@latest --claude --codex
 *   npx @pilosite/peer-ai@latest --uninstall
 *   npx @pilosite/peer-ai@latest --version
 *   npx @pilosite/peer-ai@latest --help
 *
 * Zero runtime dependencies — uses only Node core (fs, path, os, readline, child_process).
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

// -------- Supported AIs --------
// Each AI is both a potential "source" (the one that has the skill installed and
// can initiate a consultation) and a potential "target" (the one being consulted).
// A source can only call targets that are actually installed on the machine.
const AIS = {
  claude: {
    label: 'Claude Code',
    binary: 'claude',
    detect: () => which('claude'),
    // Global = user-level install under ~/.claude/commands/
    // Local  = project-level install under ./.claude/commands/
    installPath: (scope, cwd) =>
      scope === 'local'
        ? path.join(cwd, '.claude', 'commands', 'peer-ai.md')
        : path.join(os.homedir(), '.claude', 'commands', 'peer-ai.md'),
    // Instructions file the model reads on every session. We append a
    // peer-ai block here so the model knows the skill exists.
    instructionsPath: (scope, cwd) =>
      scope === 'local'
        ? path.join(cwd, 'CLAUDE.md')
        : path.join(os.homedir(), '.claude', 'CLAUDE.md'),
    templateDir: 'claude',
    writer: writeClaudeSkill,
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
    templateDir: 'codex',
    writer: writeCodexSkill,
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
    templateDir: 'gemini',
    writer: writeGeminiExtension,
  },
};

// Instructions block markers — used to detect, update, or remove the peer-ai
// section inside CLAUDE.md / AGENTS.md / GEMINI.md. Keep these in sync with
// templates/instructions-block.md.tmpl.
const INSTRUCTIONS_OPEN_MARKER = '<!-- peer-ai Configuration — managed by peer-ai installer';
const INSTRUCTIONS_CLOSE_MARKER = '<!-- /peer-ai Configuration -->';

// -------- Args parsing --------
const args = process.argv.slice(2);
const hasGlobal = args.includes('--global') || args.includes('-g');
const hasLocal = args.includes('--local') || args.includes('-l');
const hasAll = args.includes('--all');
const hasUninstall = args.includes('--uninstall') || args.includes('-u');
const hasVersion = args.includes('--version') || args.includes('-v');
const hasHelp = args.includes('--help') || args.includes('-h');
const hasYes = args.includes('--yes') || args.includes('-y');
const hasClaude = args.includes('--claude');
const hasCodex = args.includes('--codex');
const hasGemini = args.includes('--gemini');
const hasNoInstructions = args.includes('--no-instructions');
const hasInstructions = args.includes('--instructions');

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
  const missingList = Object.keys(detected).filter((k) => !detected[k]);

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

  // Step 4: For each source, determine targets (which AIs it can call)
  // Default: each source can call every *other* installed AI
  const sourceTargets = {};
  for (const src of sources) {
    const candidates = installedList.filter((k) => k !== src);
    if (hasAll || hasYes) {
      sourceTargets[src] = candidates;
    } else {
      sourceTargets[src] = await askTargets(src, candidates);
    }
  }

  // Step 5: Preview plan
  console.log(`${bold}Install plan:${reset}`);
  for (const src of sources) {
    const ai = AIS[src];
    const tgts = sourceTargets[src];
    const tgtLabels = tgts.length > 0 ? tgts.map((t) => AIS[t].label).join(', ') : `${dim}(no targets — will only expose /list)${reset}`;
    const installPath = ai.installPath(scope, cwd);
    console.log(`  ${cyan}${ai.label}${reset}`);
    console.log(`    path:    ${dim}${installPath}${reset}`);
    console.log(`    targets: ${tgtLabels}`);
  }
  console.log();

  // Step 6: Confirm
  if (!hasYes && !hasAll) {
    const confirmed = await askYesNo('Proceed with install?', true);
    if (!confirmed) {
      console.log(`${yellow}Install cancelled.${reset}`);
      process.exit(0);
    }
  }

  // Step 7: Write files
  let successCount = 0;
  for (const src of sources) {
    const ai = AIS[src];
    const tgts = sourceTargets[src];
    try {
      const installPath = ai.installPath(scope, cwd);
      ai.writer({ installPath, targets: tgts, version: pkg.version });
      console.log(`${green}✓${reset} Installed ${ai.label} skill -> ${dim}${installPath}${reset}`);
      successCount++;
    } catch (err) {
      console.error(`${red}✗${reset} Failed to install ${ai.label}: ${err.message}`);
    }
  }

  // Step 8: Optionally update instructions files (CLAUDE.md / AGENTS.md / GEMINI.md)
  // so the model knows the skill exists and when to use it. This is opt-in.
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
    printUsageHint(sources);
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
  for (const [key, ai] of Object.entries(AIS)) {
    const installPath = ai.installPath(scope, cwd);
    if (fs.existsSync(installPath)) {
      try {
        if (fs.statSync(installPath).isDirectory()) {
          fs.rmSync(installPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(installPath);
          // Also remove parent dir if it's a peer-ai-specific dir and empty
          const parent = path.dirname(installPath);
          if (path.basename(parent) === 'peer-ai') {
            try { fs.rmdirSync(parent); } catch {}
          }
        }
        console.log(`${green}✓${reset} Removed ${ai.label} skill: ${dim}${installPath}${reset}`);
        removed++;
      } catch (err) {
        console.error(`${red}✗${reset} Failed to remove ${ai.label}: ${err.message}`);
      }
    }

    // Also strip the peer-ai block from the instructions file, if present.
    // Opt-out via --no-instructions, same as install.
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
  }

  if (removed === 0 && blocksRemoved === 0) {
    console.log(`${dim}Nothing to remove at ${scope} scope.${reset}`);
  } else {
    const parts = [];
    if (removed > 0) parts.push(`${removed} skill${removed > 1 ? 's' : ''}`);
    if (blocksRemoved > 0) parts.push(`${blocksRemoved} instructions block${blocksRemoved > 1 ? 's' : ''}`);
    console.log(`\n${green}✓ Uninstalled peer-ai (${parts.join(', ')}).${reset}`);
  }
}

// -------- Instructions file helpers --------

/**
 * Add or update the peer-ai block in an instructions file (CLAUDE.md / AGENTS.md / GEMINI.md).
 * Returns: 'created' | 'added' | 'updated' | 'unchanged'.
 *
 * Behavior:
 *   - File doesn't exist → create it with just the block
 *   - File exists, no block → append the block with a blank line separator
 *   - File exists, block present → replace the block in place (idempotent)
 */
function updateInstructions({ filePath, targets, version }) {
  const blockTemplate = readTemplate('instructions-block.md.tmpl');
  const block = renderTemplate(blockTemplate, { targets, version });

  if (!fs.existsSync(filePath)) {
    writeFileAtomic(filePath, block);
    return 'created';
  }

  const existing = fs.readFileSync(filePath, 'utf8');
  const openIdx = existing.indexOf(INSTRUCTIONS_OPEN_MARKER);
  const closeIdx = existing.indexOf(INSTRUCTIONS_CLOSE_MARKER);

  if (openIdx >= 0 && closeIdx > openIdx) {
    // Block exists — replace in place
    const before = existing.slice(0, openIdx);
    const after = existing.slice(closeIdx + INSTRUCTIONS_CLOSE_MARKER.length);
    const updated = before + block.trimEnd() + after;
    if (updated === existing) return 'unchanged';
    fs.writeFileSync(filePath, updated, 'utf8');
    return 'updated';
  }

  // Block missing — append with a separator
  const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(filePath, existing + separator + block, 'utf8');
  return 'added';
}

/**
 * Remove the peer-ai block from an instructions file. Leaves the rest of the file intact.
 * Returns true if a block was removed, false otherwise.
 */
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
    // File would be empty — delete it entirely to avoid leaving orphan files.
    fs.unlinkSync(filePath);
    return true;
  }
  fs.writeFileSync(filePath, cleaned, 'utf8');
  return true;
}

// -------- Writers --------
function writeClaudeSkill({ installPath, targets, version }) {
  const template = readTemplate('claude/peer-ai.md.tmpl');
  const rendered = renderTemplate(template, { targets, version });
  writeFileAtomic(installPath, rendered);
}

function writeCodexSkill({ installPath, targets, version }) {
  const template = readTemplate('codex/SKILL.md.tmpl');
  const rendered = renderTemplate(template, { targets, version });
  writeFileAtomic(installPath, rendered);
}

function writeGeminiExtension({ installPath, targets, version }) {
  // Gemini extension is a directory with:
  //   gemini-extension.json
  //   commands/<target>.toml     (one per installed target)
  //   commands/list.toml         (always)
  const extJson = readTemplate('gemini/gemini-extension.json.tmpl');
  writeFileAtomic(
    path.join(installPath, 'gemini-extension.json'),
    renderTemplate(extJson, { targets, version }),
  );

  // list.toml is always installed
  const listTmpl = readTemplate('gemini/commands/list.toml.tmpl');
  writeFileAtomic(
    path.join(installPath, 'commands', 'list.toml'),
    renderTemplate(listTmpl, { targets, version }),
  );

  // Per-target command files — only for targets that were requested
  for (const target of targets) {
    const templatePath = `gemini/commands/${target}.toml.tmpl`;
    if (!templateExists(templatePath)) {
      console.warn(`${yellow}⚠${reset} No Gemini template for target "${target}", skipping`);
      continue;
    }
    const tmpl = readTemplate(templatePath);
    writeFileAtomic(
      path.join(installPath, 'commands', `${target}.toml`),
      renderTemplate(tmpl, { targets, version }),
    );
  }
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
 *   {{version}}                 -> the peer-ai version string
 *   {{targets_list}}            -> comma-separated labels, e.g. "Claude, Gemini"
 *   {{targets_keys}}            -> comma-separated keys, e.g. "claude, gemini"
 *   {{#if_target NAME}}...{{/if_target}}   -> include block only if NAME is in targets
 *   {{#each_target}}...{{/each_target}}    -> repeat block for each target; use {{target_key}} and {{target_label}} inside
 */
function renderTemplate(tmpl, ctx) {
  const { targets, version } = ctx;
  const labels = {
    claude: 'Claude Code',
    codex: 'Codex CLI (OpenAI)',
    gemini: 'Gemini CLI (Google)',
  };

  let out = tmpl;

  // {{#each_target}}...{{/each_target}}
  out = out.replace(/\{\{#each_target\}\}([\s\S]*?)\{\{\/each_target\}\}/g, (_, block) => {
    return targets
      .map((t) =>
        block
          .replace(/\{\{target_key\}\}/g, t)
          .replace(/\{\{target_label\}\}/g, labels[t] || t),
      )
      .join('');
  });

  // {{#if_target NAME}}...{{/if_target}}
  out = out.replace(/\{\{#if_target\s+(\w+)\}\}([\s\S]*?)\{\{\/if_target\}\}/g, (_, name, block) => {
    return targets.includes(name) ? block : '';
  });

  // Simple substitutions
  out = out.replace(/\{\{targets_list\}\}/g, targets.map((t) => labels[t] || t).join(', '));
  out = out.replace(/\{\{targets_keys\}\}/g, targets.join(', '));
  out = out.replace(/\{\{version\}\}/g, version);

  return out;
}

// -------- File helpers --------
function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
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
  npx @pilosite/peer-ai@latest [OPTIONS]

${bold}SCOPE${reset}
  -g, --global      Install under your home directory (~/.claude, ~/.codex, ...)
  -l, --local       Install under the current project (./.claude, ./.codex, ...)

${bold}SOURCES${reset}
      --claude      Install peer-ai in Claude Code (must be detected)
      --codex       Install peer-ai in Codex CLI
      --gemini      Install peer-ai in Gemini CLI
      --all         Install in all detected sources, each calling all others

${bold}INSTRUCTIONS FILES${reset}
      --instructions     Add/update the peer-ai block in CLAUDE.md / AGENTS.md / GEMINI.md
      --no-instructions  Skip instructions-file updates entirely
                         (default: ask interactively, yes when used with --yes/--all)

${bold}OTHER${reset}
  -y, --yes         Skip confirmation prompts, accept all defaults
  -u, --uninstall   Remove peer-ai from the scope (also strips instructions blocks)
  -v, --version     Print version
  -h, --help        Print this help

${bold}EXAMPLES${reset}
  npx @pilosite/peer-ai@latest                      # interactive install, user-level
  npx @pilosite/peer-ai@latest --all --yes          # install everywhere, no prompts
  npx @pilosite/peer-ai@latest --local --claude     # Claude Code only, project-level
  npx @pilosite/peer-ai@latest --uninstall          # remove from user-level
  npx @pilosite/peer-ai@latest --uninstall --local  # remove from project

${bold}DOCS${reset}
  https://github.com/Pilosite/peer-ai
`);
}

function printUsageHint(sources) {
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
}
