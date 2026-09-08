import { expect, test } from "bun:test";
import { isReviewBotComment } from "../src/github/comment-identity";

test("pins comment ownership to the configured immutable bot ID", () => {
  const previous = process.env.GITHUB_BOT_USER_ID;
  const user = { id: 123, login: "known-good-review[bot]", type: "Bot" };
  try {
    process.env.GITHUB_BOT_USER_ID = "456";
    expect(isReviewBotComment({ user })).toBeFalse();
    expect(isReviewBotComment({ user: { ...user, id: 456, login: "renamed[bot]" } })).toBeTrue();
    expect(isReviewBotComment({ user: { ...user, id: 456, type: "User" } })).toBeFalse();
    process.env.GITHUB_BOT_USER_ID = "invalid";
    expect(isReviewBotComment({ user })).toBeFalse();
  } finally {
    if (previous === undefined) delete process.env.GITHUB_BOT_USER_ID;
    else process.env.GITHUB_BOT_USER_ID = previous;
  }
});
