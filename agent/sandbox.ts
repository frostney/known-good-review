import {
  defaultBackend,
  defineSandbox,
  type SandboxSession,
} from "eve/sandbox";
import { githubOnlyNetworkPolicy } from "../src/github/review-workspace";

export const sandboxRuntimeRevision = "eve-0.38.3-workspace-owner-alignment";

export async function alignSandboxWorkspaceOwnership(
  sandbox: Pick<SandboxSession, "run">,
): Promise<void> {
  const result = await sandbox.run({
    command: [
      "set -eu",
      'current_uid="$(id -u)"',
      'current_gid="$(id -g)"',
      'workspace_uid="$(stat -c %u /workspace)"',
      'if [ "$workspace_uid" != "$current_uid" ]; then',
      '  sudo chown "$current_uid:$current_gid" /workspace',
      "fi",
      'workspace_uid="$(stat -c %u /workspace)"',
      'printf "%s:%s\\n" "$current_uid" "$workspace_uid"',
      'test "$workspace_uid" = "$current_uid"',
    ].join("\n"),
  });
  if (result.exitCode !== 0) {
    const observedOwnership = result.stdout.trim() || "unknown";
    throw new Error(
      `Eve sandbox command user must own /workspace; observed ${observedOwnership}.`,
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
    await alignSandboxWorkspaceOwnership(await use());
  },
});
