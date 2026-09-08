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

## Compatibility and rollout

This change requires a coordinated maintenance window. The new app requires
`/memory/admission`, which the old backend lacks. The new backend rejects old
ingestion requests without admission receipts and old deletion request shapes.
Do not run arbitrary mixtures of old and new instances.

1. Verify an operator-supported way to pause incoming Connect delivery while
   preserving events for replay. If delivery cannot be paused durably, stop the
   rollout and implement a compatible staged migration first.
2. Drain active Eve reviews and scheduled Convex ingestion, migration and
   deletion work. Record the deployed app/backend versions and a recoverable
   database backup before mutation.
3. Deploy the matching Convex functions and schema, then the app with its signing
   key and verified full sandbox build. Keep ingress paused through both steps.
4. Check `/eve/v1/health`, authenticated memory admission, and sandbox startup.
   Resume delivery only when both matching deployments are healthy. Start fresh
   review sessions; unsigned evidence cannot resume under the new verifier.

Old sessions without admission receipts may finish publication but skip memory
ingestion. New sessions restore admission. A new signing key also invalidates
old signed evidence, so preserve the configured key during retries.

## Recovery limits

An app-only rollback would restore callers incompatible with the new backend.
The old Convex schema may reject newly written fields and tables. An immediate
two-sided rollback has not been validated. Keep ingress paused after a failed
rollout and repair forward or rehearse a compatible recovery on a disposable
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
