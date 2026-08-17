import {
  defaultBackend,
  defineSandbox,
  type SandboxSession,
} from "eve/sandbox";
import { githubOnlyNetworkPolicy } from "../src/github/review-workspace";

export const sandboxRuntimeRevision = "eve-0.38.3-workspace-owner";

export async function assertSandboxWorkspaceOwnership(
  sandbox: Pick<SandboxSession, "run">,
): Promise<void> {
  const result = await sandbox.run({
    command: [
      "set -eu",
      'current_user="$(id -un)"',
      'workspace_owner="$(stat -c %U /workspace)"',
      'printf "%s:%s\\n" "$current_user" "$workspace_owner"',
      'test "$current_user" = vercel-sandbox',
      'test "$workspace_owner" = "$current_user"',
    ].join("\n"),
  });
  if (result.exitCode !== 0) {
    const observedOwnership = result.stdout.trim() || "unknown";
    throw new Error(
      `Eve sandbox must run as vercel-sandbox and own /workspace; observed ${observedOwnership}.`,
    );
  }
}

export default defineSandbox({
  backend: defaultBackend({
    vercel: {
      networkPolicy: githubOnlyNetworkPolicy,
      resources: { vcpus: 2 },
    },
    microsandbox: {
      cpus: 2,
      memoryMiB: 4096,
      networkPolicy: githubOnlyNetworkPolicy,
    },
    // Docker cannot broker per-domain credentials. Keep its local fallback
    // offline; microsandbox is the faithful local security model.
    docker: { networkPolicy: "deny-all" },
  }),
  revalidationKey: () => sandboxRuntimeRevision,
  async bootstrap({ use }) {
    await assertSandboxWorkspaceOwnership(await use());
  },
});
