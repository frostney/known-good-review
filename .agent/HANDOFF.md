# Handoff

## Current task

Scaffold `known-good-review` as a review-only standalone Eve GitHub App for
Vercel, using Bun, AI Gateway, Vercel Sandbox, the official Chat SDK GitHub
adapter, and the merged known-good-route `code-review` skill. Publish the
completed scaffold as a pull request.

## Completed decisions and implementation

- Full review and delta review are exclusive. The first reviewable state gets
  one full review; completed baselines receive exact semantic deltas plus prior
  finding revalidation. Merge/rebase-only changes reuse evidence without a
  model call. Lost or failed baselines fail closed until an authorized manual
  full command.
- Trusted configuration is read only from the PR base SHA. `model` and
  optional `agents` support exact allowed model IDs and comma-separated Gateway
  fallbacks. Agent maps use only the four `code-review` axes.
- Review state and the canonical v2 findings artifact live in hidden GitHub PR
  comments. Publication creates or updates the `known-good-review` Check and
  stable finding comments.
- Patch identity includes normalized diff content and GitHub content SHA, so
  omitted patches for binary or oversized files cannot cause false semantic
  reuse.
- Telemetry records model/provider, tokens, cache tokens, exact Gateway cost,
  timings, outcome, and review kind without recording prompts or outputs.
- Project-local skills were installed through Skills CLI. Runtime
  `code-review` includes all references and is provenance-pinned.
- No GitHub App, Vercel project, connector, deployment, package publication, or
  other external resource was created.

## Skill source state

- known-good-route PR #38 was merged.
- Consumed source revision:
  `e3aad669dc127e5af6b1fea1ccccf0cc70b0e093`
- That revision upgrades `code-review` and `codebase-audit` findings JSON to v2,
  rejects v1 revalidation input, clarifies operations versus axes, and adds
  behavioral eval coverage.
- Project and Eve runtime copies were installed from
  `frostney/known-good-route` through the Skills CLI. The runtime `code-review`
  directory is byte-identical to the merged source. known-good-review does not
  author known-good-route skills.
- Global Claude `codex-review` was compared. Its Standards, Spec, and
  conditional Security passes are already covered by engineering quality,
  claim and specification, and the conditional adversarial reference. Its
  pinned-boundary invariant is also present; its Codex CLI/model plumbing is
  intentionally not copied into the reusable skill.

## Validation

- App: `bun run check` (typecheck, deterministic tests, Eve diagnostics,
  production build; no paid model calls).
- known-good-route: `bun run check` (34 Bun tests, 18 Python tests, dry eval
  matrix; no paid model calls).
- Agent Skills validation passed for runtime and project copies of
  `code-review`, `codebase-audit`, `grilling`, `grill-with-docs`,
  `domain-modeling`, and `run-retro`.

## Open work

- Observe exact-head CI and review state on the known-good-review pull request.
- External GitHub/Vercel setup remains unauthorized and undone.
