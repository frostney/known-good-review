import type { GitHubWebhookVerifier } from "eve/channels/github";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const repositoryReferenceSchema = z.object({
  node_id: z.string().min(1),
});

const lifecyclePayloadSchema = z
  .looseObject({
    action: z.string(),
    installation: z
      .looseObject({
        id: z.number().int().positive(),
        account: z.unknown().optional(),
        repository_selection: z.string().optional(),
      }),
    repositories_removed: z.array(repositoryReferenceSchema).optional(),
  });

export type GitHubLifecycleEvent =
  | {
      readonly kind: "installation-deleted";
      readonly installationId: number;
    }
  | {
      readonly kind: "repositories-removed";
      readonly installationId: number;
      readonly repositoryIds: readonly string[];
    };

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function parseGitHubLifecycleEvent(
  body: string,
  eventName: string | null,
): GitHubLifecycleEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = lifecyclePayloadSchema.safeParse(raw);
  if (!parsed.success) return null;
  const payload = parsed.data;
  const installationId = payload.installation.id;

  if (
    (eventName === "installation_repositories" || eventName === null) &&
    payload.action === "removed" &&
    payload.repositories_removed !== undefined
  ) {
    return {
      kind: "repositories-removed",
      installationId,
      repositoryIds: unique(
        payload.repositories_removed.map((repository) => repository.node_id),
      ),
    };
  }

  const fullInstallation =
    payload.installation.account !== undefined ||
    payload.installation.repository_selection !== undefined;
  if (
    (eventName === "installation" ||
      (eventName === null && fullInstallation)) &&
    payload.action === "deleted"
  ) {
    return { kind: "installation-deleted", installationId };
  }
  return null;
}

export async function handleGitHubLifecycleWebhook(input: {
  readonly request: Request;
  readonly verifier: GitHubWebhookVerifier;
  readonly deleteRepositories: (input: { installationId: number; repositoryIds: readonly string[]; deliveryId: string }) => Promise<void>;
  readonly reconcileInstallation: (input: {
    installationId: number; retainedRepositoryIds: readonly string[]; deliveryId: string; uninstalled: boolean;
  }) => Promise<void>;
  readonly listAccessibleRepositories: (
    installationId: number,
  ) => Promise<readonly string[]>;
}): Promise<Response | null> {
  const eventName = input.request.headers.get("x-github-event");
  const rawBody = await input.request.clone().text();
  if (parseGitHubLifecycleEvent(rawBody, eventName) === null) return null;

  let verified: unknown;
  try {
    verified = await input.verifier(input.request, rawBody);
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  if (!verified) return new Response("unauthorized", { status: 401 });

  const verifiedBody = typeof verified === "string" ? verified : rawBody;
  const event = parseGitHubLifecycleEvent(verifiedBody, eventName);
  if (event === null) {
    return Response.json(
      { error: "invalid GitHub lifecycle payload", ok: false },
      { status: 400 },
    );
  }

  const nativeDeliveryId = input.request.headers.get("x-github-delivery")?.trim();
  if (nativeDeliveryId && nativeDeliveryId.length > 200) return Response.json({ error: "invalid delivery identity", ok: false }, { status: 400 });
  // Connect-forwarded requests can omit native headers, as supported by Eve.
  // A local job ID binds their paged cleanup; current access is rechecked below.
  const deliveryId = nativeDeliveryId || `forwarded:${randomUUID()}`;
  try {
    if (event.kind === "installation-deleted") {
      await input.reconcileInstallation({ installationId: event.installationId, retainedRepositoryIds: [], deliveryId, uninstalled: true });
    } else {
      const retained = unique(await input.listAccessibleRepositories(event.installationId));
      if (event.repositoryIds.length > 0) {
        const accessible = new Set(retained);
        const removed = event.repositoryIds.filter((id) => !accessible.has(id));
        if (removed.length) await input.deleteRepositories({ installationId: event.installationId, repositoryIds: removed, deliveryId });
      } else {
        await input.reconcileInstallation({ installationId: event.installationId, retainedRepositoryIds: retained, deliveryId, uninstalled: false });
      }
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "known-good-review.memory.lifecycle_cleanup_failed",
        deliveryId: input.request.headers.get("x-github-delivery"),
        error: error instanceof Error ? error.name : "unknown",
        installationId: event.installationId,
        lifecycle: event.kind,
      }),
    );
    return Response.json(
      { error: "repository memory cleanup unavailable", ok: false },
      { status: 503 },
    );
  }

  return Response.json({ ok: true }, { status: 202 });
}
