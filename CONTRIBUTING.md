# Contributing to peer-ai

Thanks for your interest — peer-ai is a small project, so contributions land fast.

## Local development

```bash
# Sanity-check the installer
node --check bin/install.js

# Dry-run against a sandbox home
rm -rf /tmp/peer-ai-sandbox && mkdir /tmp/peer-ai-sandbox
HOME=/tmp/peer-ai-sandbox node bin/install.js --all --yes --global
find /tmp/peer-ai-sandbox -type f

# Dry-run uninstall
HOME=/tmp/peer-ai-sandbox node bin/install.js --uninstall --global
```

## Adding a new AI target

To support a new AI CLI (e.g. Cursor, Windsurf, Qwen Code):

1. **Register the AI** in `bin/install.js` under the `AIS` constant. Provide:
   - `label` — human-readable name
   - `binary` — command name used with `which`
   - `detect` — returns path or null
   - `installPath(scope, cwd)` — where the skill lives
   - `instructionsPath(scope, cwd)` — the corresponding CLAUDE.md-equivalent
   - `templateDir` — subdirectory name under `templates/`
   - `writer` — function that renders and writes the skill
2. **Write a writer function** (similar to `writeClaudeSkill`, `writeCodexSkill`, `writeGeminiExtension`) and a writer wire-up below.
3. **Add templates** under `templates/<new-ai>/`. At minimum:
   - One primary skill file template (e.g. `SKILL.md.tmpl`)
   - Any per-target sub-templates if the AI's format is one-file-per-target (like Gemini)
4. **Update the label map** in `renderTemplate()` (`const labels = ...`).
5. **Update `printUsageHint`** to document the new AI's invocation syntax.
6. **Add a flag** (`--new-ai`) near the top of the args parser and thread it through `runInstall`.
7. **Update `templates/instructions-block.md.tmpl`** if the new AI has an instructions-file convention.
8. **Run the sandbox install** and verify everything renders correctly.
9. **Update `README.md`** and `CHANGELOG.md`.

## Publishing

Publishing is handled by GitHub Actions on `v*` tags.

```bash
# bump version
npm version minor          # or patch / major
git push origin main --follow-tags
```

The workflow at `.github/workflows/publish.yml` checks the tag matches `package.json`, runs a syntax check, and publishes to npm with provenance.

You'll need an `NPM_TOKEN` secret in the repo settings (a granular access token with publish rights to `peer-ai`).

## Testing manually

There's no test harness yet — the installer is simple enough that the sandbox dry-run above catches most issues. If you're adding non-trivial logic (e.g. a new scope, a new renderer helper), please add a manual test recipe in your PR description.

Future: proper vitest suite with fixture dirs.

## Code style

- Zero runtime dependencies — keep it that way. Node core only.
- CJS (`.cjs` or plain `.js` with `require`) for the installer. Node 18+ is the minimum.
- No TypeScript for runtime code — keeps the install size tiny and the code editable by anyone.
- Templates are markdown or TOML — substitution via the minimal template engine in `bin/install.js` (search `renderTemplate`).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
