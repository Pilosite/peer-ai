# Changelog

All notable changes to **peer-ai** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] — 2026-06-18 — Antigravity CLI replaces Gemini CLI

Replace Gemini CLI peer with Antigravity CLI (agy) — gemini-cli sunset by Google for AI Pro/Ultra on 2026-06-18.

### Changed
- **The `gemini` peer is replaced by `antigravity` (binary `agy`).** Google sunsets
  Gemini CLI for AI Pro/Ultra users on 2026-06-18; Antigravity CLI (`agy`) is its
  successor. This is a clean replace, not a deprecated alias — gemini-cli is gone for
  the affected tiers, so pointing users at it would be a dead end.
- **Detection:** the installer now probes `which agy` instead of `which gemini`.
- **Invocation:** the peer is now called as `agy -p "$(cat "$BRIEF")" --dangerously-skip-permissions`
  (prompt is the `-p`/`--print` flag value, NOT stdin as gemini-cli used). The guard's
  target regex matches `agy -p` / `--print` / `--prompt`.
- **Peer label:** "Gemini CLI (Google)" → "Antigravity CLI (agy, Google)". User-facing
  command is now `/peer-ai antigravity <question>` (was `/peer-ai gemini`).
- **Config surface unchanged.** Antigravity reuses Gemini CLI's `~/.gemini` directory:
  extension at `~/.gemini/extensions/peer-ai/` (manifest stays `gemini-extension.json`),
  instructions in `GEMINI.md`, hook under `BeforeTool` + `run_shell_command` in
  `~/.gemini/settings.json`. So existing installs upgrade in place.
- Templates moved from `templates/gemini/` to `templates/antigravity/`; the renderer
  label map, writer (`writeAntigravityExtension`), and hook writer
  (`writeAntigravityHook`) renamed accordingly.

### Added
- `--antigravity` install flag (the canonical source flag for the Antigravity peer).
- Guard test asserting `agy -p` is detected and capped like any other target.

### Compatibility
- The `--gemini` flag is kept as a **backward-compat alias** for `--antigravity` so
  existing scripts and muscle memory don't break — it now installs the Antigravity peer.
- Note: this version intentionally does NOT pass `--output-format json` to `agy`. Some
  `agy` builds advertise it, but installed releases (e.g. 1.0.9) reject the flag with
  "flag provided but not defined". The plain `-p` form returns clean stdout; the skill
  templates note the JSON-envelope option for builds that support it.

## [0.2.1] — Per-exchange-chain cap (bug fix)

### Fixed
- **Counter no longer accumulates silently across CLI sessions / `/clear` cycles.** The
  v0.2.0 cap was effectively a global per-target counter with a single 60-min TTL: a
  user could `/clear`, start fresh, and immediately hit a "5/5 reached" block from
  rounds accumulated in prior sessions. The cap is now interpreted as **per
  exchange chain**, not per CLI session — its true intent.
- **Per-target `last_activity` timestamps.** Previously a single global
  `last_activity` field meant codex activity refreshed gemini's TTL (and vice
  versa). Now each target ages independently: a stale codex chain auto-resets
  without disturbing an active gemini chain.
- **`ttl_minutes` default lowered from 60 to 30.** A real exchange chain (rapid
  back-and-forth) finishes within minutes; 30 min is a generous safety margin
  before the next call is treated as a fresh dialogue.

### Changed
- `~/.peer-ai/rounds.json` schema migrated from
  `{ rounds: { codex: 2 }, last_activity: "..." }` to
  `{ chains: { codex: { count: 2, last_activity: "..." } } }`. The guard reads
  the legacy shape transparently and rewrites it on the next allow-decision —
  no manual migration needed.
- All template skill files (Claude / Codex / Gemini) and `CLAUDE.md` /
  `AGENTS.md` / `GEMINI.md` instructions blocks updated to describe the cap as
  "per exchange chain" and to clarify that `/clear` does NOT reset the counter
  (use `npx @pilosite/peer-ai@latest reset <target>` for an immediate reset).
- `peer-ai status` now displays per-chain age and per-chain auto-reset countdown
  for each target, instead of a single global "last activity" line.

### Added
- `npm test` — zero-dependency Node test suite at `test/guard.test.js` covering
  rapid-cap blocking, per-target TTL expiry, per-target isolation, legacy-schema
  migration, env-var override, and hard_block toggle.

### Migration
- No action required. Existing `~/.peer-ai/rounds.json` files are auto-migrated
  on the next guard invocation. Existing `~/.peer-ai/config.json` keeps any
  `ttl_minutes` you explicitly set; only the unset default changes.

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
