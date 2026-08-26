# known-good-review

This is a standalone Eve agent application. Use Bun for dependency management,
scripts, tests, and local execution. Keep `CLAUDE.md` as only `@AGENTS.md`.

Before changing Eve integration code, read the matching guide bundled with the
installed `eve` package under `node_modules/eve/docs/`. Verify APIs against the
installed declarations and source. Discover integrations with `bun x eve
registry search <query> --json` and prefer native registry items.

Project-local development skills live under `.agents/skills/` and are managed
through `skills-lock.json`; never copy skill folders by hand. The runtime
`code-review` skill lives under `agent/skills/code-review/` and must come from
the recorded known-good-route revision through the Skills CLI.

The app is review-only. It must never push branches, merge pull requests,
change repository settings, or expose GitHub, Gateway, or telemetry credentials
to a repository sandbox. Read `.github/known-good-review.yml` only from the
trusted base revision of the pull request.

Before any production or live review after changing a model-facing tool schema,
lane report schema, report mapper, or canonical finding contract, prove the
change offline against the actual generated tool JSON Schema and downstream
report assembly. Cover every finding variant, application-owned field, path
constraint, and duplicate identity, then run `bun run replay:pr61` and preserve
all recorded finding transitions. Do not use a live or paid review to discover
a deterministic contract mismatch.

Run `bun run check` before handing off a change. Update `.agent/HANDOFF.md` at
the end of a substantial session.
