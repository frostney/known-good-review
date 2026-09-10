import type { ConnectOptions } from "@vercel/connect";
import { connectGitHubCredentials, type ConnectGitHubCredentialsParams } from "@vercel/connect/eve";
import { connectGitHubRecoveryFetch } from "./connect-recovery";

export function connectedGitHubChannel(
  connector: string,
  params: ConnectGitHubCredentialsParams = {},
  options?: ConnectOptions,
) {
  const credentials = connectGitHubCredentials(connector, params, options);
  const resolveToken = credentials.installationToken;
  if (typeof resolveToken !== "function") {
    throw new Error("Vercel Connect GitHub credentials did not provide a token resolver");
  }
  return {
    credentials,
    api: {
      fetch: connectGitHubRecoveryFetch(
        connector, { ...params, subject: { type: "app" } }, resolveToken,
      ),
    },
  };
}
