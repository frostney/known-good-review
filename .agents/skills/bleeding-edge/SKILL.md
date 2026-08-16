---
name: bleeding-edge
description: >-
  Biases technology choices toward the newest viable option while preserving
  maintainability, live verification, reversibility, and decided constraints.
  Use when selecting or upgrading a dependency, runtime, tool, language feature,
  or AI model.
license: Unlicense OR MIT
---

# Bleeding edge

Prefer the newest viable technology inside the requested work. This is a bias,
not permission for an unrelated upgrade sweep or novel architecture.
`software-engineering-excellence` remains the governor; maintainability wins
ties.

## Stability ladder

| Rung | Policy |
| --- | --- |
| Newest stable | Default, including newly released majors |
| RC, beta, canary | Only for a concrete need or low-risk reversible trial |
| Nightly | Only for a documented blocker it resolves |

## Adoption contract

For every choice:

- Verify version and release status from the registry or official release notes.
- Read relevant migration notes and check known blockers for the use case.
- Pin any pre-release or nightly exactly.
- Record the reason, tradeoff, rollback path, and fallback when climbing beyond
  stable.
- Run the project's real validation gate without weakening it.
- Prefer the newer option only when capability, security, performance, developer
  experience, or longevity outweighs instability and churn.

## Existing decisions

Project AGENTS, stack skills, and recorded decisions remain authoritative.
Advance within an already chosen tool; never silently replace it. If another
tool now appears materially better, present the evidence and tradeoff for human
decision.

When the choice remains uncertain, state the rung and unresolved risk instead of
quietly choosing the most novel option.
