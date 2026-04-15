# Changelog

All notable changes to **peer-ai** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — Initial release

### Added
- Zero-dependency Node installer (`npx peer-ai@latest`) supporting:
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
