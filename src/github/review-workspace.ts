import { getToken } from "@vercel/connect";
import type { SandboxNetworkPolicy } from "eve/sandbox";
import { z } from "zod";
import { githubConnector } from "./chat-adapter";
import type { TrustedGitHubContext } from "./trusted-context";

const privateSubnets = [
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
] as const;

export const githubOnlyNetworkPolicy: SandboxNetworkPolicy = {
  allow: ["github.com", "*.github.com", "*.githubusercontent.com"],
  subnets: { deny: [...privateSubnets] },
};

const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);

interface ReviewWorkspaceSandbox {
  removePath(options: {
    readonly force?: boolean;
    readonly path: string;
    readonly recursive?: boolean;
  }): Promise<void>;
  run(options: { readonly command: string }): PromiseLike<{
    readonly exitCode: number;
    readonly stderr: unknown;
    readonly stdout: unknown;
  }>;
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
}

interface ReviewWorkspaceDependencies {
  readonly getInstallationToken: (installationId: number) => Promise<string>;
}

const defaultDependencies: ReviewWorkspaceDependencies = {
  getInstallationToken: (installationId) =>
    getToken(githubConnector, {
      installationId: String(installationId),
      subject: { type: "app" },
    }),
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function gitCommand(argumentsSource: string): string {
  return [
    "GIT_CONFIG_GLOBAL=/dev/null",
    "GIT_CONFIG_SYSTEM=/dev/null",
    "GIT_LFS_SKIP_SMUDGE=1",
    "GIT_TERMINAL_PROMPT=0",
    "git",
    argumentsSource,
  ].join(" ");
}

function commandFailure(
  operation: string,
  result: { readonly exitCode: number; readonly stderr: unknown },
): Error {
  const stderr = String(result.stderr).trim();
  return new Error(
    stderr.length > 0
      ? `${operation} failed: ${stderr.slice(0, 1_000)}`
      : `${operation} failed with exit code ${result.exitCode}`,
  );
}

async function runGit(
  sandbox: ReviewWorkspaceSandbox,
  operation: string,
  argumentsSource: string,
) {
  const result = await sandbox.run({ command: gitCommand(argumentsSource) });
  if (result.exitCode !== 0) throw commandFailure(operation, result);
  return result;
}

function repositoryUrl(context: TrustedGitHubContext): string {
  return `https://github.com/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repo)}.git`;
}

function authenticatedGitHubPolicy(
  context: TrustedGitHubContext,
  installationToken: string,
): SandboxNetworkPolicy {
  const authorization = Buffer.from(
    `x-access-token:${installationToken}`,
  ).toString("base64");
  return {
    allow: {
      "github.com": [
        {
          match: {
            method: ["GET", "POST"],
            path: {
              startsWith: `/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repo)}.git/`,
            },
          },
          transform: [{ headers: { authorization: `Basic ${authorization}` } }],
        },
      ],
      "*.github.com": [],
      "*.githubusercontent.com": [],
    },
    subnets: { deny: [...privateSubnets] },
  };
}

export async function prepareReviewWorkspace(
  context: TrustedGitHubContext,
  sandbox: ReviewWorkspaceSandbox,
  dependencies: ReviewWorkspaceDependencies = defaultDependencies,
): Promise<void> {
  const baseSha = revisionSchema.parse(context.baseSha);
  const headSha = revisionSchema.parse(context.headSha);
  const installationToken = await dependencies.getInstallationToken(
    context.installationId,
  );

  await sandbox.removePath({ path: ".git", recursive: true, force: true });
  await runGit(sandbox, "Git repository initialization", "init --quiet /workspace");
  await runGit(
    sandbox,
    "Git remote configuration",
    `-C /workspace remote add origin ${shellQuote(repositoryUrl(context))}`,
  );

  let credentialsBrokered = false;
  try {
    await sandbox.setNetworkPolicy(
      authenticatedGitHubPolicy(context, installationToken),
    );
    credentialsBrokered = true;
    await runGit(
      sandbox,
      "Trusted pull request fetch",
      [
        "-C /workspace fetch --force --no-tags --depth=1 origin",
        shellQuote(`+${baseSha}:refs/known-good-review/base`),
        shellQuote(
          `+refs/pull/${context.pullRequest}/head:refs/known-good-review/head`,
        ),
      ].join(" "),
    );
  } finally {
    if (credentialsBrokered) {
      await sandbox.setNetworkPolicy(githubOnlyNetworkPolicy);
    }
  }

  for (const [label, expected] of [
    ["base", baseSha],
    ["head", headSha],
  ] as const) {
    const resolved = await runGit(
      sandbox,
      `Trusted ${label} revision validation`,
      `-C /workspace rev-parse ${shellQuote(`refs/known-good-review/${label}^{commit}`)}`,
    );
    if (String(resolved.stdout).trim() !== expected) {
      throw new Error(`Fetched trusted ${label} revision did not match GitHub`);
    }
  }

  await runGit(
    sandbox,
    "Trusted head checkout",
    `-C /workspace checkout --detach --force ${shellQuote("refs/known-good-review/head")}`,
  );
  await runGit(
    sandbox,
    "Review workspace cleanup",
    "-C /workspace clean -ffd",
  );
}
