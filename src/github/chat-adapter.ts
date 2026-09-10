import { createGitHubAdapter } from "@chat-adapter/github";
import { connectGitHubAdapter, type ConnectGitHubAdapterParams } from "@vercel/connect/chat";
import type { ConnectOptions } from "@vercel/connect";
import { connectGitHubRecoveryFetch } from "./connect-recovery";
import { reviewBotLogin } from "./comment-identity";

export const githubConnector =
  process.env.KNOWN_GOOD_REVIEW_GITHUB_CONNECTOR ??
  "github/known-good-review";

export function githubAdapter(installationId: number) {
  const botUserId = process.env.GITHUB_BOT_USER_ID;
  return connectedGitHubAdapter(githubConnector, {
    installationId: String(installationId),
  }, {
    ...(botUserId ? { botUserId: Number(botUserId) } : {}),
  });
}

export function connectedGitHubAdapter(
  connector: string,
  params: ConnectGitHubAdapterParams,
  adapterOptions: { readonly botUserId?: number } = {},
  connectOptions?: ConnectOptions,
) {
  const native = connectGitHubAdapter(connector, params, connectOptions);
  const adapter = createGitHubAdapter({
    ...native,
    ...adapterOptions,
    userName: reviewBotLogin,
  });
  const recoveryFetch = connectGitHubRecoveryFetch(
    connector, { ...params, subject: { type: "app" } }, native.installationToken,
  );
  adapter.octokit.hook.before("request", (options) => {
    options.request = { ...options.request, fetch: recoveryFetch };
  });
  return adapter;
}
