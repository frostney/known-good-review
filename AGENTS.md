# known-good-review

This is a standalone Eve agent application. Use Bun for dependency management,
scripts, tests, and local execution. Keep `CLAUDE.md` as only `@AGENTS.md`.

Before changing or debugging Eve integration code, load the project-local
official `eve` skill, then read the matching guide bundled with the installed
`eve` package under `node_modules/eve/docs/`. Verify APIs against the installed
declarations and source. Discover integrations with `bun x eve registry search
<query> --json` and prefer native registry items.

Before changing or debugging AI SDK or AI Gateway integration code, load the
project-local official `ai-sdk` skill. Verify behavior against the installed
`ai`, `@ai-sdk/*`, and provider package documentation, declarations, source,
and tests. Do not substitute remembered or hand-authored provider behavior for
the installed implementation.

Use the official deterministic test surfaces before building project-owned
model simulation: `MockLanguageModelV4`, `MockProviderV4`, `mockValues`, and
`simulateReadableStream` from AI SDK, and `mockModel` plus deterministic eval
assertions from Eve. Exercise Gateway transport and error normalization from
raw HTTP responses through the installed provider.

Keep the test tiers explicit. `bun test` owns pure and in-memory contract
checks, including provider-visible JSON Schema, tool input rejection, report
assembly, routing, instrumentation, recovery, and recorded production replay.
`bun run test:e2e:mock` owns one provider-free Eve runtime smoke test for build,
boot, HTTP session streaming, root-copy delegation, and child completion. Do
not duplicate schema matrices in the Eve smoke fixture.

`bun run check` is the hard offline completion gate. It must pass TypeScript,
unit and integration tests, the deterministic Eve runtime smoke test, Eve
discovery with no diagnostics, and the production build. The recorded PR 61
replay must preserve all four canonical finding transitions. These checks must
not require model, judge, reporter, Gateway, GitHub, or telemetry credentials.

Real-model evals own model-dependent quality: appropriate tool and axis use,
material finding coverage, duplicate and false-positive control, canonical
finding and revalidation behavior, and complete exact-head review delivery.
Tag them `real-model` and run them only with explicit paid authorization.
Report phase latency, tokens, cache use, and cost for comparison, but do not use
diff-size heuristics or hard time, token, or cost acceptance caps.

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

Apply the same rule to AI SDK, AI Gateway, and Eve lifecycle changes: cover the
installed package boundary with the official deterministic mocks or evals and
recorded production envelopes before any paid review. A paid review is final
canary validation, not a debugging or contract-discovery step.

Run `bun run check` before handing off a change. Update `.agent/HANDOFF.md` at
the end of a substantial session.
