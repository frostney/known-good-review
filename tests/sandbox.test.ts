import { describe, expect, test } from "bun:test";
import reviewSandbox, {
  assertSandboxWorkspaceOwnership,
  sandboxRuntimeRevision,
} from "../agent/sandbox";

describe("review sandbox", () => {
  test("pins the Eve workspace ownership runtime revision", () => {
    expect(sandboxRuntimeRevision).toBe("eve-0.38.3-workspace-owner");
    expect(reviewSandbox.revalidationKey?.()).toBe(sandboxRuntimeRevision);
    expect(reviewSandbox.bootstrap).toBeFunction();
  });

  test("accepts the Eve runtime user owning the workspace", async () => {
    const commands: string[] = [];
    await assertSandboxWorkspaceOwnership({
      async run({ command }) {
        commands.push(command);
        return {
          exitCode: 0,
          stdout: "vercel-sandbox:vercel-sandbox\n",
          stderr: "",
        };
      },
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('test "$current_user" = vercel-sandbox');
    expect(commands[0]).toContain('stat -c %U /workspace');
  });

  test("rejects a runtime user that does not own the workspace", async () => {
    await expect(
      assertSandboxWorkspaceOwnership({
        async run() {
          return {
            exitCode: 1,
            stdout: "root:vercel-sandbox\n",
            stderr: "",
          };
        },
      }),
    ).rejects.toThrow(
      "Eve sandbox must run as vercel-sandbox and own /workspace; observed root:vercel-sandbox.",
    );
  });
});
