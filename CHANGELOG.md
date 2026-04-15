# Changelog

All notable changes to **peer-ai** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — Hard-block hooks + runtime config

### Added
- **Hard-block hooks** on all three CLIs via native hook systems:
  - Claude Code `PreToolUse` hook in `~/.claude/settings.json`
  - Codex CLI `PreToolUse` hook in `~/.codex/hooks.json` (installer auto-flips the `codex_hooks = true` feature flag in `config.toml` with user consent)
  - Gemini CLI `BeforeTool` hook on `run_shell_command` in `~/.gemini/settings.json`
- Shared **guard script** `~/.peer-ai/guard.js` that:
  - Reads hook payload from stdin (common schema across the 3 CLIs)
  - Pattern-matches peer-ai consultations (`codex exec`, `claude -p`, `gemini <`)
  - Enforces the per-session round cap with a hard `exit 2` + clear stderr reason
  - Auto-resets a session after `ttl_minutes` of inactivity (default 60)
  - Fails open on any unexpected error (never breaks the user's workflow)
- **Runtime configuration** in `~/.peer-ai/config.json` with keys:
  - `max_rounds` — per-target-per-session cap (default 5)
  - `ttl_minutes` — session auto-reset TTL (default 60)
  - `hard_block` — toggle hard enforcement (default true)
- New **subcommands**:
  - `peer-ai config get [KEY]` — print full config or a single key
  - `peer-ai config set KEY VALUE` — update a key (with type coercion)
  - `peer-ai config reset` — restore defaults
  - `peer-ai reset [TARGET]` — wipe the round counter (all targets or one)
  - `peer-ai status` — show current config + round usage per target
- New **install flags**:
  - `--max-rounds N` — set the cap at install time
  - `--hooks` / `--no-hooks` — opt in/out of hard-block hooks (default interactive)
- Environment variable **`PEER_AI_MAX_ROUNDS`** — temporary per-shell override of the cap
- Environment variable **`PEER_AI_DEBUG=1`** — enable guard decision logging to `~/.peer-ai/guard.log`
- Templates now render `{{max_rounds}}` dynamically and tell the model the cap is configurable
- Gemini fingerprint warning is flagged during install so users aren't surprised
- Uninstall now strips hook entries, guard script, and `~/.peer-ai/` directory cleanly

### Changed
- Install flow now includes a "max rounds" prompt and a "hard-block hooks?" prompt when interactive
- Skill templates include a two-layer enforcement explanation (hook + self-check) with instructions for blocked-state recovery

### Notes
- The `codex_hooks = true` flag is **preserved** on uninstall (we don't know if other tools rely on it)
- After uninstall, settings.json files may remain as `{}` — by design, to preserve any other hooks a user may have configured

## [0.1.0] — Initial release

### Added
- Zero-dependency Node installer (`npx @pilosite/peer-ai@latest`) supporting:
  - Interactive install with CLI auto-detection
  - `--global` (user-level, default) and `--local` (project-level) scopes
  - Per-source target matrix selection
  - Flag shortcuts: `--claude`, `--codex`, `--gemini`, `--all`, `--yes`
  - Optional instructions-file updates (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) with `--instructions` / `--no-instructions`
  - Clean `--uninstall` that strips skills + instructions blocks in place
- Skill templates for three AIs:
  - Claude Code: slash command `/peer-ai <target> <prompt>`
  - Codex CLI: skill at `~/.codex/skills/peer-ai/SKILL.md`
  - Gemini CLI: extension with per-target slash commands (`/peer-ai:codex`, `/peer-ai:claude`, `/peer-ai:list`)
- Smart-context assembly heuristics (diffs, files, architecture, debug)
- Bounded follow-ups (max 5 rounds per target per session) to prevent AI-to-AI loops
- Read-only sandbox for Codex peer invocations (non-negotiable)
- Dynamic templates — only enabled targets appear in the rendered skills
- Optional consultation history persistence in `~/.claude/peer-ai-history/` etc.
