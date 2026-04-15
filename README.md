# peer-ai

> **AI-to-AI peer consultation.** Let Claude Code, Codex CLI, and Gemini CLI ask each other for a second opinion, code review, or deep analysis — with one command.

[![npm version](https://img.shields.io/npm/v/@pilosite/peer-ai.svg)](https://www.npmjs.com/package/@pilosite/peer-ai)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

---

## Why

You're using Claude Code. You reach a conclusion that feels load-bearing — a security-sensitive fix, an architecture call, a regex nobody understands. Before you ship it, you want a **second opinion from a different model family**: Codex for typed-language rigor, Gemini for a fresh perspective, another Claude session for independent validation.

Today you'd open another terminal, copy-paste the diff, write a brief, paste the response back. Multiply by 10 reviews a week.

**peer-ai** installs a symmetric skill/extension in each AI CLI you use, so any of them can call the others with one line:

```
/peer-ai codex review the last 2 commits
/peer-ai claude second opinion on this auth flow
/peer-ai gemini what's wrong with this SQL
```

The source AI assembles a smart brief (diff, relevant files, your question), calls the target CLI in read-only mode, and relays the response verbatim. Bounded to 5 rounds per target per session so you don't get stuck in an AI-to-AI loop.

## What it is

peer-ai is a **Node zero-dependency installer** that scaffolds one skill file per AI CLI you pick:

| Source AI      | What gets installed                                 | Invocation              |
| -------------- | --------------------------------------------------- | ----------------------- |
| **Claude Code**| `~/.claude/commands/peer-ai.md` (slash command)     | `/peer-ai <target> ...` |
| **Codex CLI**  | `~/.codex/skills/peer-ai/SKILL.md` (auto-discovered)| "ask claude", "second opinion" |
| **Gemini CLI** | `~/.gemini/extensions/peer-ai/` (extension)         | `/peer-ai:<target> ...` |

The installer is **dynamic** — only the targets you select appear in the rendered skills. Install Claude Code + Codex only? Neither skill will mention Gemini. Add Gemini later? Re-run `npx @pilosite/peer-ai@latest` and it updates in place.

## Quick start

```bash
# Interactive install — the installer detects which AIs you have,
# asks which should be sources, and picks targets per source.
npx @pilosite/peer-ai@latest
```

Non-interactive, install everywhere detected:

```bash
npx @pilosite/peer-ai@latest --all --yes
```

Project-local install instead of user-level:

```bash
npx @pilosite/peer-ai@latest --local
```

Uninstall (strips both skills and the CLAUDE.md / AGENTS.md / GEMINI.md blocks):

```bash
npx @pilosite/peer-ai@latest --uninstall
```

## How it works

### Installation

When you run `npx @pilosite/peer-ai@latest`:

1. **Detect.** `which claude`, `which codex`, `which gemini` — list what's on the machine.
2. **Scope.** User-level (`~/.claude/...`) or project-level (`./.claude/...`)? Interactive unless `--global` / `--local`.
3. **Sources.** Which AIs should have peer-ai installed? Any AI you select becomes capable of initiating a consultation.
4. **Targets per source.** For each source, which other AIs can it consult? You can pick a partial matrix — e.g. Claude Code calls Codex only, Gemini calls both.
5. **Plan preview.** Shows exactly what will be written where.
6. **Instructions files (opt-in).** Optionally adds a short block to `CLAUDE.md` (for Claude Code), `AGENTS.md` (for Codex), `GEMINI.md` (for Gemini) so the model knows the skill exists and when to use it. Bracketed with HTML markers so re-runs update in place cleanly.
7. **Write & confirm.** Templates are rendered with your target matrix substituted, files written atomically.

### At runtime

When you invoke the skill (example: `/peer-ai codex review last 2 commits` from Claude Code):

1. **Parse.** Extract target (`codex`) and question (`review last 2 commits`).
2. **Verify.** `which codex` — if the CLI disappeared since install, refuse cleanly.
3. **Budget check.** Max N consultations per target per session (default 5, configurable). Enforced by two layers: a **hard-block hook** (native PreToolUse/BeforeTool on each CLI — the guard script at `~/.peer-ai/guard.js` refuses with exit 2 + stderr), and a **soft self-check** in the skill markdown as defense-in-depth. Sessions auto-reset after 60 minutes of inactivity. You can also reset manually with `npx @pilosite/peer-ai@latest reset [target]`, raise the cap permanently with `config set max_rounds N`, or override temporarily with `export PEER_AI_MAX_ROUNDS=N`.
4. **Smart context.** The source AI decides what to include in the brief based on the question: diff for "review", specific files for "look at X", architecture docs for "design", error logs for "debug". Deliberately capped around 5000 tokens unless you explicitly ask for deep review.
5. **Invoke.** Writes brief to a temp file, calls the target CLI in its non-interactive / read-only mode:
   - **Codex:** `codex exec --sandbox read-only --skip-git-repo-check --output-last-message "$OUT" --color never - < "$BRIEF"`
   - **Gemini:** `gemini < "$BRIEF" > "$OUT"`
   - **Claude:** `claude -p "$(cat "$BRIEF")" > "$OUT"` (fresh session, zero prior context)
6. **Relay.** Presents the response **verbatim** under a clear heading. No paraphrasing — you see what the peer actually said.
7. **History (optional).** For non-trivial consultations, asks if you want to keep a trace under `~/.<cli>/peer-ai-history/YYYY-MM-DD-HHMM-<target>.md`.
8. **Follow-up offer.** One opportunity to ask a follow-up, then stops. Codex supports native session resume; Claude and Gemini re-include prior exchange as context in a new brief.

### Guardrails

These aren't nice-to-haves — they're baked into every skill template so the source AI respects them.

- **Read-only sandbox on peer Codex.** Never downgrade below `--sandbox read-only`. The peer reviews, it doesn't write.
- **Bounded rounds.** N per target per session (default 5, configurable), enforced by native hooks on all 3 CLIs (`PreToolUse` on Claude/Codex, `BeforeTool` on Gemini). Prevents infinite ping-pong when two models disagree. See "Managing the cap" below.
- **No secrets leakage.** Briefs are scrubbed for env vars, API keys, tokens before being sent to a peer.
- **Prompt injection defense.** When a brief includes LLM prompts (e.g. reviewing a prompt template file), they're wrapped in `<user_content>...</user_content>` XML delimiters so the peer parses them as data, not instructions.
- **No delegated understanding.** The peer reviews and reports. The source AI synthesizes and decides. Skills are written to refuse "based on your findings, fix it" style delegation.

## Managing the cap

The per-session consultation cap (default 5 per target) is enforced by a native hook on each CLI, backed by a shared guard script at `~/.peer-ai/guard.js`. You can tweak or override it at three levels:

### Change it permanently

```bash
npx @pilosite/peer-ai@latest config set max_rounds 10
npx @pilosite/peer-ai@latest config get            # verify
```

This writes `~/.peer-ai/config.json`. The guard reads this file on every invocation, so the change takes effect immediately without restarting any CLI.

### Override just this shell

```bash
export PEER_AI_MAX_ROUNDS=15
# ... peer-ai calls in this terminal now use 15 as the cap ...
```

When the shell closes (or you `unset PEER_AI_MAX_ROUNDS`), you're back to whatever is in `config.json`. Useful for one-off debug sessions where you need a higher cap without bumping it permanently.

### Reset the counter

```bash
npx @pilosite/peer-ai@latest reset            # all targets
npx @pilosite/peer-ai@latest reset codex      # only codex
```

Wipes the round counter in `~/.peer-ai/rounds.json` without touching the cap. The cap stays at whatever it is; you just start over from zero for that session.

### Check where you are

```bash
npx @pilosite/peer-ai@latest status
```

Shows current cap, per-target usage, time since last activity, and when the session will auto-reset. If any target is at the cap, it's marked in red as `BLOCKED`.

### Auto-reset

Sessions automatically reset after **60 minutes of inactivity** by default. That TTL is also configurable:

```bash
npx @pilosite/peer-ai@latest config set ttl_minutes 30
```

### Disable the hard block

If for some reason you want the skill templates to be the only enforcement (no hook, no hard block):

```bash
# At install time
npx @pilosite/peer-ai@latest --no-hooks --all --yes

# Or flip it later
npx @pilosite/peer-ai@latest config set hard_block false
```

Not recommended — the soft check relies on the model honestly counting its own invocations. Hooks exist precisely because that's not always reliable.

## Install scenarios

### Solo dev with all 3 CLIs

```bash
npx @pilosite/peer-ai@latest --all --yes
```

Every source can call every target. You'll see the skill appear in all 3 CLIs after restart.

### Team project, shared config in the repo

```bash
cd my-project
npx @pilosite/peer-ai@latest --local --all
git add .claude .codex .gemini CLAUDE.md AGENTS.md GEMINI.md
git commit -m "chore: add peer-ai for cross-model code review"
```

Teammates get peer-ai activated automatically on `git pull` in their respective CLIs.

### Only Claude Code installed, curious about adding Codex later

```bash
npx @pilosite/peer-ai@latest --claude --yes
```

Only Claude Code gets the skill, with no targets (just `/peer-ai:list` to check what's installable). When you add Codex later, re-run with `--all` and it updates in place.

### CI / scripted install

```bash
npx @pilosite/peer-ai@latest --all --global --yes --instructions
```

Non-interactive, everywhere, instructions blocks auto-added. Suitable for dotfiles bootstrap or container images.

### Uninstall fully

```bash
npx @pilosite/peer-ai@latest --uninstall            # user-level
npx @pilosite/peer-ai@latest --uninstall --local    # project-level
```

Removes skills **and** the peer-ai block in CLAUDE.md / AGENTS.md / GEMINI.md. Other content in those files is preserved.

## Flags reference

```
SCOPE
  -g, --global          Install under your home directory (default)
  -l, --local           Install under the current project

SOURCES
      --claude          Install peer-ai in Claude Code (must be detected)
      --codex           Install peer-ai in Codex CLI
      --gemini          Install peer-ai in Gemini CLI
      --all             Install in all detected sources

INSTRUCTIONS FILES
      --instructions     Add/update the peer-ai block in CLAUDE.md / AGENTS.md / GEMINI.md
      --no-instructions  Skip instructions-file updates entirely
                         (default: ask interactively, yes with --yes/--all)

OTHER
  -y, --yes             Skip confirmation prompts
  -u, --uninstall       Remove peer-ai from the scope
  -v, --version         Print version
  -h, --help            Print help
```

## FAQ

### Do the AIs actually talk to each other, or is it just one-shot?

One-shot by default — the peer CLI is invoked in non-interactive mode, answers once, exits. Follow-up rounds are supported up to 5 per target per session (soft counter). Beyond that, the skill refuses and suggests `/clear` or switching targets. This is deliberately conservative — the goal is "second opinion", not "long AI-to-AI conversation".

### Is it expensive?

Each consultation is one LLM call on the peer side. A review of ~2 commits typically generates a ~3-5k token brief and ~500-1000 token response. For Claude, Codex, and Gemini, that's a few cents per consultation. The 5-rounds-per-session budget exists partly to bound cost, partly to bound noise.

### Why not just copy-paste into the other CLI myself?

You can. peer-ai exists because (a) assembling the right brief every time is tedious and you do it 10 times a week, (b) piping through non-interactive mode with the right flags (`--sandbox read-only`, `--output-last-message`, `-p`, etc.) is fiddly, (c) having the source AI assemble the brief means it includes the right context without you explaining it twice, (d) symmetry matters — any AI can consult any other with the same mental model.

### What happens if I'm not in a git repo?

Most invocations still work — the source AI assembles context from files you mention, error logs, or the conversation. Some heuristics that rely on `git diff` will fall back to asking you which files to include. peer-ai itself uses `--skip-git-repo-check` when calling Codex so the peer doesn't refuse.

### Does this replace `/gsd:review`?

No — they solve different problems. `/gsd:review` (part of [get-shit-done-cc](https://github.com/gsd-build/get-shit-done)) is specialized for reviewing GSD phase plans with a structured output format. peer-ai is a general-purpose consultation gateway, not tied to any planning methodology. They can coexist.

### Can I add a new AI CLI (e.g. Cursor, Windsurf, Qwen)?

Yes, but you'll need to fork. The installer `AIS` registry (in `bin/install.js`) declares each supported AI with its detection, install path, and writer. Add a new entry, write templates under `templates/<ai>/`, and the rest of the flow works. PRs welcome.

### Is my data sent to a cloud when peer-ai runs?

peer-ai itself is just a Node installer — it doesn't touch any network. At runtime, the source AI calls the **target CLI** directly on your machine, and that target CLI may make its own API calls per its own config (Claude→Anthropic, Codex→OpenAI, Gemini→Google). peer-ai adds no telemetry, no middleman, no extra network hop.

### Can I use peer-ai in an air-gapped environment?

If your target CLIs work offline (local models via Ollama, for example), peer-ai works offline. It's just pipes and temp files between local processes.

### How do I update to a newer version?

```bash
npx @pilosite/peer-ai@latest   # always pulls the latest
```

The installer is idempotent — re-running updates the skills in place with the latest templates. If you pinned to a specific version, pass `peer-ai@0.2.0` instead of `@latest`.

### Contributions welcome?

Yes — issues, PRs, new AI targets, template improvements. Start with `npm run test` (coming soon), then open a PR against `main`.

## Credits

- Installer pattern inspired by [get-shit-done-cc](https://github.com/gsd-build/get-shit-done), which pioneered the "one install script, many AI CLI integrations" approach.
- Huge thanks to the teams at Anthropic (Claude Code), OpenAI (Codex CLI), and Google (Gemini CLI) for shipping tools that make this kind of interop possible.

## License

MIT — see [LICENSE](LICENSE).
