import type { ModelMessage } from "ai";
import {
  parseReviewConfig,
  modelsForAxis,
  type ModelChain,
  type ReviewConfig,
} from "../config/review-config";
import { isReviewAxis, type ReviewAxis } from "../review/axes";

export const routingAttribute = "known_good_review_config";
const routingPattern =
  /<known-good-review-routing>(\{[^<]+\})<\/known-good-review-routing>/g;

export type ReviewRoute =
  | { readonly role: "coordinator"; readonly attempt: number }
  | { readonly role: "lane"; readonly axis: ReviewAxis; readonly attempt: number }
  | { readonly role: "revalidation"; readonly attempt: number };

function textFromMessage(message: ModelMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .map((part) => {
      if (typeof part === "object" && part !== null && "text" in part) {
        return typeof part.text === "string" ? part.text : "";
      }
      return "";
    })
    .join("\n");
}

function parseAttempt(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error("Review routing attempt must be a non-negative integer");
  }
  return value as number;
}

export function parseSubagentRoute(messages: readonly ModelMessage[]): ReviewRoute {
  const text = messages.map(textFromMessage).join("\n");
  const matches = [...text.matchAll(routingPattern)];
  const encoded = matches.at(-1)?.[1];
  if (!encoded) {
    throw new Error("Review subagent message is missing its routing envelope");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error("Review subagent routing envelope is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || !("role" in parsed)) {
    throw new Error("Review subagent routing envelope is malformed");
  }
  const role = parsed.role;
  const attempt = parseAttempt("attempt" in parsed ? parsed.attempt : 0);
  if (role === "revalidation") {
    return { role, attempt };
  }
  if (role === "lane" && "axis" in parsed && typeof parsed.axis === "string") {
    if (!isReviewAxis(parsed.axis)) {
      throw new Error(`Unknown review axis ${JSON.stringify(parsed.axis)}`);
    }
    return { role, axis: parsed.axis, attempt };
  }
  throw new Error("Review subagent routing role must be lane or revalidation");
}

export function chainForRoute(
  config: ReviewConfig,
  route: ReviewRoute,
): ModelChain {
  if (route.role === "lane") {
    return modelsForAxis(config, route.axis);
  }
  if (route.role === "revalidation" && config.agents.kind === "all") {
    return config.agents.models;
  }
  return config.model;
}

export function selectRoutedModel(input: {
  readonly attributes: Readonly<
    Record<string, string | readonly string[]>
  > | null;
  readonly channelKind: string | undefined;
  readonly messages: readonly ModelMessage[];
}): {
  readonly model: string;
  readonly modelOptions?: {
    readonly providerOptions: {
      readonly gateway: {
        readonly caching: "auto";
        readonly models?: readonly string[];
      };
    };
  };
} {
  const rawConfig = input.attributes?.[routingAttribute];
  const config =
    typeof rawConfig === "string"
      ? parseReviewConfig(rawConfig)
      : parseReviewConfig(null);
  const route: ReviewRoute =
    input.channelKind === "subagent"
      ? parseSubagentRoute(input.messages)
      : { role: "coordinator", attempt: 0 };
  const chain = chainForRoute(config, route);
  const model = chain[route.attempt];
  if (model === undefined) {
    throw new Error(
      `Review model fallback attempt ${route.attempt} is outside the trusted chain`,
    );
  }
  const fallbacks = chain.slice(route.attempt + 1);
  return {
    model,
    modelOptions: {
      providerOptions: {
        gateway: {
          caching: "auto" as const,
          ...(fallbacks.length > 0 ? { models: fallbacks } : {}),
        },
      },
    },
  };
}

export function routingEnvelope(route: Exclude<ReviewRoute, { role: "coordinator" }>): string {
  return `<known-good-review-routing>${JSON.stringify(route)}</known-good-review-routing>`;
}
