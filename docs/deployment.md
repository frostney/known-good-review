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

1. Run `bun run migration:check` with a production credential that has
   `deployment:data:view`. A separate, expiring read-only key can run this gate
   locally without widening the existing Vercel deployment key. Supply it only
   to the check process through `CONVEX_DEPLOY_KEY`, verify its deployment target,
   and never print or upload it. Record the aggregate result and revoke the key
   after validation. An authorized browser login alone does not authenticate
   the CLI or build environment.
2. Build the exact CI-green app revision in the existing production environment
   with `bunx eve build`, immediately after the check passes. Override the combined build
   command for this deployment only; do not deploy Convex yet. Use Vercel's
   `--prod --skip-domain` to defer domain promotion. This does not isolate the
   candidate from production Workflow routing; see the routing limitation below.
3. Verify the app and sandbox, then promote it to the existing production alias
   used for direct application access. Connect targets the project and its
   `/eve/v1/github` route. No incoming events need to be paused. During this phase,
   reviews publish normally and skip new memory ingestion.
4. Inspect Workflow runs and steps. Retire parked sessions from older app
   deployments through supported session controls; let real active turns and
   HTTP invocations finish. New full/delta dispatches already reset sessions.
   Never restart old unsigned evidence as a new review.
5. Run `bun run migration:check` again immediately before the backend switch,
   using the same separate read access or a suitably scoped build credential.
   It reads tables through the native Convex CLI without logging their contents
   and rejects queued/running scheduled work, pending ingestion, migration and
   deletion. If inspection exceeds its bound, drain through paginated inspection
   first. A browser snapshot is useful corroboration, but does not replace this gate.
6. After old callers and actions are drained, deploy the backend with the new
   app using `bunx convex deploy --cmd 'bunx eve build'`.
   Preserve the existing evidence key and the shared memory token.
7. Verify fresh admission, revocation, hosted sandbox and publication. Start a
   fresh full/delta evaluation. Reviews begun during the transition retain null
   admission and skip ingestion even if they finish after backend promotion.

This order matters: old callers are incompatible with the new backend, and old
executing Convex actions can call internal functions whose contracts changed.
Do not infer drained work from an idle workflow count alone. Sleeping session
and timeout workflows remain pinned to their original deployment until retired.
Confirm each reset's exact previous session ID, then inspect Workflow to prove
the old run is terminal and its associated timeout helper is stopped. A reset
response alone is insufficient for sessions pinned to an older Eve version.

### Protected candidate access

A production candidate can reject the local Vercel SDK's development OIDC token
with `TRUSTED_SOURCES_ENVIRONMENT_MISMATCH`. This happens before the app receives
the request. Do not relax deployment protection to make a health check pass.
Use an existing authorized automation bypass, a signed-in browser, or a production
workload's OIDC token. Vercel builds receive their own `VERCEL_OIDC_TOKEN`; an
unpromoted production build can validate an existing immutable candidate with
the public OIDC SDK and Eve client. Check the token's project, team and environment
without logging it, and require both ready health and valid production agent info.

After promotion, a publicly accessible production alias can use the same local
OIDC token as bearer authentication for Eve without adding the trusted-source
header. Verify the alias's deployment ID before session controls. Keep operational
probe code in build-time inputs and keep credentials out of logs and sandboxes.

### Workflow routing limitation

Installed Eve 0.45 starts new production sessions with Workflow's
`deploymentId: "latest"`; no public Eve option pins those starts to the serving
deployment. The provider resolves that value to the latest successful production
deployment, including a candidate created with `--skip-domain`. Promotion of a
different domain does not change that resolver result. Existing runs retain
their original deployment.

Treat every successful production candidate as eligible to receive new workflows.
All app-first candidates must tolerate the old backend before they become ready.
Operational probe builds must contain the same validated runtime revision, and
their probes belong only in build-time inputs. Record the actual run deployment
ID, rather than inferring it from the domain. Hold deployments fixed during a
full/delta comparison. Full candidate isolation requires separate infrastructure
or an upstream Eve capability; domain staging alone cannot provide it.

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
