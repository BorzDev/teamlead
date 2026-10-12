# Changelog

## 1.1.0 — 2026-10-12

- Update Codex routing: Astra / ultra leads; GPT-6.1 Sol / high implements and reviews; Sol / xhigh handles sensitive work; GPT-6 Luna / medium handles narrow tasks.
- Adopt one persistent workflow for Codex and Claude Code: one helper at a time by default, focused checks for simple edits, and plans and scouting only when needed.
- Keep review independent: reviewers read, workers fix, and the same reviewer verifies the fixes. Limit review to two started rounds per delta, including retries and failed final checks.
- Integrate the supplied Claude skill: Haiku 5.5, Sonnet 5.5, Opus 5.5, and Fable 5.1 routing. Use native Agent with explicit effort and SendMessage; require Claude Code 2.1.292+. No user-local custom agent definitions are needed.
- Preserve baseline snapshots, staged changes, permission boundaries, accepted-risk reporting, and state across context compaction. The mode lasts until explicitly canceled.
- Replace unused Workflow templates and their simulations with portable-bundle checks. Publish a versioned skill archive through GitHub Actions.

Reinstall the entire skill with `npx skills add BorzDev/teamlead`. Back up any local edits first. Live Claude Code execution is not covered by the bundle checks.
