import type { GitHubWebhookVerifier } from "eve/channels/github";
import { z } from "zod";

const repositoryReferenceSchema = z.object({
  node_id: z.string().min(1),
});

const lifecyclePayloadSchema = z
  .object({
    action: z.string(),
    installation: z
      .object({
        id: z.number().int().positive(),
        account: z.unknown().optional(),
        repository_selection: z.string().optional(),
      })
      .passthrough(),
    repositories_removed: z.array(repositoryReferenceSchema).optional(),
  })
  .passthrough();

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
  readonly deleteRepositories: (repositoryIds: readonly string[]) => Promise<void>;
  readonly reconcileInstallation: (
    installationId: number,
    retainedRepositoryIds: readonly string[],
  ) => Promise<void>;
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

  try {
    if (event.kind === "installation-deleted") {
      await input.reconcileInstallation(event.installationId, []);
    } else if (event.repositoryIds.length > 0) {
      await input.deleteRepositories(event.repositoryIds);
    } else {
      const retained = await input.listAccessibleRepositories(
        event.installationId,
      );
      await input.reconcileInstallation(event.installationId, unique(retained));
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
