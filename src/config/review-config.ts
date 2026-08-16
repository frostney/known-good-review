import { parse } from "yaml";
import { z } from "zod";
import { reviewAxes, type ReviewAxis } from "../review/axes";

export const defaultModel = "openai/gpt-5.6-sol" as const;
export const allowedModels = [
  defaultModel,
  "anthropic/claude-opus-5",
  "moonshotai/kimi-k3",
] as const;

export type AllowedModel = (typeof allowedModels)[number];
export type ModelChain = readonly [AllowedModel, ...AllowedModel[]];

export interface ReviewConfig {
  readonly model: ModelChain;
  readonly agents:
    | { readonly kind: "inherit" }
    | { readonly kind: "all"; readonly models: ModelChain }
    | {
        readonly kind: "axes";
        readonly models: Readonly<Partial<Record<ReviewAxis, ModelChain>>>;
      };
}

const rawConfigSchema = z
  .object({
    model: z.string().optional(),
    agents: z
      .union([
        z.string(),
        z
          .object(
            Object.fromEntries(
              reviewAxes.map((axis) => [axis, z.string().optional()]),
            ) as Record<ReviewAxis, z.ZodOptional<z.ZodString>>,
          )
          .strict(),
      ])
      .optional(),
  })
  .strict();

function parseModelChain(value: string, field: string): ModelChain {
  const models = value
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model.length > 0);

  if (models.length === 0) {
    throw new Error(`${field} must contain at least one model`);
  }

  const unique = [...new Set(models)];
  if (unique.length !== models.length) {
    throw new Error(`${field} must not repeat a model`);
  }

  for (const model of unique) {
    if (!(allowedModels as readonly string[]).includes(model)) {
      throw new Error(
        `${field} contains unknown model ${JSON.stringify(model)}; allowed models: ${allowedModels.join(", ")}`,
      );
    }
  }

  const [first, ...rest] = unique as AllowedModel[];
  if (first === undefined) {
    throw new Error(`${field} must contain at least one model`);
  }
  return [first, ...rest];
}

export function parseReviewConfig(source: string | null | undefined): ReviewConfig {
  if (source === null || source === undefined || source.trim() === "") {
    return { model: [defaultModel], agents: { kind: "inherit" } };
  }

  let document: unknown;
  try {
    document = parse(source);
  } catch (error) {
    throw new Error(
      `Invalid .github/known-good-review.yml: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = rawConfigSchema.safeParse(document ?? {});
  if (!result.success) {
    throw new Error(
      `Invalid .github/known-good-review.yml: ${z.prettifyError(result.error)}`,
    );
  }

  const model = parseModelChain(result.data.model ?? defaultModel, "model");
  const agents = result.data.agents;
  if (agents === undefined) {
    return { model, agents: { kind: "inherit" } };
  }
  if (typeof agents === "string") {
    return {
      model,
      agents: { kind: "all", models: parseModelChain(agents, "agents") },
    };
  }

  const models: Partial<Record<ReviewAxis, ModelChain>> = {};
  for (const axis of reviewAxes) {
    const configured = agents[axis];
    if (configured !== undefined) {
      models[axis] = parseModelChain(configured, `agents.${axis}`);
    }
  }

  return { model, agents: { kind: "axes", models } };
}

export function modelsForAxis(
  config: ReviewConfig,
  axis: ReviewAxis,
): ModelChain {
  if (config.agents.kind === "all") {
    return config.agents.models;
  }
  if (config.agents.kind === "axes") {
    return config.agents.models[axis] ?? config.model;
  }
  return config.model;
}
