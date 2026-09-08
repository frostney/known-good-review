export const reviewBotLogin = "known-good-review[bot]";

export interface GitHubCommentAuthor {
  readonly user?: {
    readonly id?: number | undefined;
    readonly login?: string | undefined;
    readonly type?: string | undefined;
  } | null | undefined;
}

export function isReviewBotComment(comment: GitHubCommentAuthor): boolean {
  if (comment.user?.type !== "Bot") return false;
  const configuredId = process.env.GITHUB_BOT_USER_ID;
  if (configuredId) {
    const id = Number(configuredId);
    return Number.isSafeInteger(id) && id > 0 && comment.user.id === id;
  }
  return comment.user.login === reviewBotLogin;
}
