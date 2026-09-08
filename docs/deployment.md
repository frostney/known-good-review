# Audit rollout and live validation

Use the existing Vercel project and Convex production deployment. Verify both
identities through authenticated provider access before changing configuration.
The local validation build skips sandbox prewarming; it does not certify a
deployable hosted sandbox. Verify that the Vercel build runs `bun x eve build`
without `--skip-sandbox-prewarm`, with permission to create sandbox templates.
The installed Eve deployment guide is the command reference for this release.

## Release gate

The release commit must pass `bun run check` and `bun run replay:pr61`, including
the generated tool-schema contracts, on both supported Bun versions in CI.
Record the commit, deployment IDs, configured model IDs, trusted base revision,
and provider versions with each live result. Never include secret values.

Configure `KNOWN_GOOD_REVIEW_EVIDENCE_KEY` only in the app environment: 32 random
bytes encoded as 64 hexadecimal characters, stable across replicas and restarts.
Preserve an existing valid key. Never inject it into repository sandboxes or
Convex. Keep the shared memory bearer token aligned between the app and Convex.

## App-first migration

Deploy the app before replacing the backend. New callers already tolerate the
old backend's missing admission endpoint: they receive no receipt and skip
advisory memory ingestion. New deletion bodies are accepted by the old Zod
contract, which strips added fields and retains existing cleanup. Search remains
compatible. `tests/memory-client.test.ts` covers this transition against the
exact old deletion schemas from `59bf616`.

1. Build the exact CI-green app revision in the existing production environment
   with `bun run migration:check && bunx eve build`. Override the combined build
   command for this deployment only; do not deploy Convex yet. Use Vercel's
   `--prod --skip-domain` so health and artifact checks precede alias promotion.
2. Verify the app and sandbox, then promote it to the existing production alias
   used by Connect. No incoming events need to be paused. During this phase,
   reviews publish normally and skip new memory ingestion.
3. Inspect Workflow runs and steps. Retire parked sessions from older app
   deployments through supported session controls; let real active turns and
   HTTP invocations finish. New full/delta dispatches already reset sessions.
   Never restart old unsigned evidence as a new review.
4. Run `bun run migration:check` in the trusted production build environment
   immediately before the backend switch. It invokes Convex's native read-only
   query and rejects queued/running scheduled work, pending ingestion, migration
   and deletion. If inspection exceeds its bound, drain through paginated
   inspection first. Credentials remain in the trusted build environment.
5. After old callers and actions are drained, deploy the backend with the new
   app using `bun run migration:check && bunx convex deploy --cmd 'bunx eve build'`.
   Preserve the existing evidence key and the shared memory token.
6. Verify fresh admission, revocation, hosted sandbox and publication. Start a
   fresh full/delta evaluation. Reviews begun during the transition retain null
   admission and skip ingestion even if they finish after backend promotion.

This order matters: old callers are incompatible with the new backend, and old
executing Convex actions can call internal functions whose contracts changed.
Do not infer drained work from an idle workflow count alone. Sleeping session
and timeout workflows remain pinned to their original deployment until retired.

Connect does not provide a documented lossless maintenance pause. Failed
forwarding gets bounded retries, so detaching Connect or returning `503` is not
an event-preserving rollout mechanism.

## Recovery limits

Before the backend switch, the old app and backend remain an app-only rollback
option. After that switch, an app-only rollback would restore incompatible callers.
The old Convex schema may reject newly written fields and tables. An immediate
two-sided rollback has not been validated. Stop the staged rollout after a failed gate and repair forward or rehearse a
compatible recovery on a disposable
deployment before restoring service. Do not erase revocation records to make an
old schema deploy: that could allow delayed requests to recreate deleted data.

## Controlled live evaluation

Use an agreed installed test repository and PR with a preserved expected-finding
set. Run one explicit `@known-good-review run full review`, then one controlled
semantic delta that fixes one expected finding and leaves another unchanged.
Verify canonical identities, finding transitions, duplicate and false-positive
control, exact-head Checks, summary and inline publication, memory admission,
and stable recovery. Keep baseline and candidate on the same input/configuration
when comparing their performance.

Record phase latency, requested and resolved models, prompt/output/cache tokens,
Gateway cost and unresolved telemetry for each run. Report quality results
alongside those measurements; one full/delta pair cannot establish a reliable
speed improvement. The PR 61 offline replay preserves recorded transitions but
does not measure current model quality or hosted latency.
