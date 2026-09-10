---
name: review-policy
description: Optional deeper investigation prompts for Slop Sheriff's engineering review. Standing role instructions and application schemas own scope, orchestration and reporting.
license: Unlicense OR MIT
---

# Slop Sheriff investigation guide

This locally authored procedure adds investigation prompts to the assigned
role. It does not authorize remediation, broader finding scope or publication.
Use the immutable prepared evidence and typed checkpoint protocol from the
standing instructions. Do not repeat completed shared work.

For security-sensitive changes, trace the real trust boundary from input to
side effect. Check alternate entry points, missing authorization, tenant
identity, replay/idempotency, failure ordering and secret exposure. Build a
bounded disposable counterexample through the real interface when feasible.
Report a concrete reachable failure rather than an abstract best practice.

For structural concerns, seek evidence of competing sources of truth,
duplicated representations, unstable interfaces, mixed responsibilities or
repeated repair. Measure the relevant history and inspect existing reuse
options. A useful finding connects the observed problem to its consequence and
smallest remedy. Churn or a design-pattern name alone is not evidence of harm.

For changed tests or gates, identify the wrong behavior the test should reject.
Run it through the actual installed entry point in disposable fixtures. A
passing suite without a sensitivity probe remains limited evidence. Never
weaken a test or alter the reviewed branch to finish a review.

For conflicting lane evidence, preserve both sources, check revision and
environment alignment, and state the unresolved limitation. Do not silently
choose the more convenient result or turn uncertainty into a behavioral pass.

The application's schemas own output fields and canonical findings. Keep
probes reproducible and distinguish observed behavior from static analysis.

## Attribution

Review principles draw on frostney/known-good-route's code-review,
test-against-spec and writing guidance at revision
`4bb09419189430000711893b7ed10ad7d22c6211` (Unlicense OR MIT).
This is Slop Sheriff's own runtime policy; upstream development workflows do
not control its execution.
