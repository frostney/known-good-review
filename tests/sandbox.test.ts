import { describe, expect, test } from "bun:test";
import reviewSandbox, {
  alignSandboxWorkspaceOwnership,
  sandboxRuntimeRevision,
} from "../agent/sandbox";

describe("review sandbox", () => {
  test("pins the Eve workspace ownership runtime revision", () => {
    expect(sandboxRuntimeRevision).toBe(
      "eve-0.38.3-workspace-owner-alignment",
    );
    expect(reviewSandbox.revalidationKey?.()).toBe(sandboxRuntimeRevision);
    expect(reviewSandbox.bootstrap).toBeFunction();
  });

  test("aligns the workspace with Eve's command user", async () => {
    const commands: string[] = [];
    await alignSandboxWorkspaceOwnership({
      async run({ command }) {
        commands.push(command);
        return {
          exitCode: 0,
          stdout: "0:0\n",
          stderr: "",
        };
      },
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(
      'sudo chown "$current_uid:$current_gid" /workspace',
    );
    expect(commands[0]).toContain('stat -c %u /workspace');
    expect(commands[0]).toContain(
      'test "$workspace_uid" = "$current_uid"',
    );
  });

  test("rejects ownership that remains mismatched", async () => {
    await expect(
      alignSandboxWorkspaceOwnership({
        async run() {
          return {
            exitCode: 1,
            stdout: "0:1000\n",
            stderr: "",
          };
        },
      }),
    ).rejects.toThrow(
      "Eve sandbox command user must own /workspace; observed 0:1000.",
    );
  });
});
