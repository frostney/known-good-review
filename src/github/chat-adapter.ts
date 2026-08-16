import { createGitHubAdapter } from "@chat-adapter/github";
import { connectGitHubAdapter } from "@vercel/connect/chat";

export const githubConnector =
  process.env.KNOWN_GOOD_REVIEW_GITHUB_CONNECTOR ??
  "github/known-good-review";

export function githubAdapter(installationId: number) {
  const botUserId = process.env.GITHUB_BOT_USER_ID;
  return createGitHubAdapter({
    ...connectGitHubAdapter(githubConnector, {
      installationId: String(installationId),
    }),
    ...(botUserId ? { botUserId: Number(botUserId) } : {}),
    userName: "known-good-review[bot]",
  });
}
