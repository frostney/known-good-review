import { parse } from "yaml";
import { z } from "zod";
import {
  embeddingConfigSchema,
  type EmbeddingConfig,
} from "../memory/contracts";
import { reviewAxes, type ReviewAxis } from "../review/axes";

export const defaultModels = [
  "openai/gpt-5.6-sol",
  "moonshotai/kimi-k3",
  "anthropic/claude-opus-5",
] as const;
export const defaultModel = defaultModels[0];
export const defaultEmbedding: EmbeddingConfig = {
  model: "voyage/voyage-4",
  dimension: 1024,
};

export type ModelChain = readonly [string, ...string[]];

export interface ReviewConfig {
  readonly model: ModelChain;
  readonly embedding: EmbeddingConfig;
  readonly publicRoots: readonly string[];
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
    embedding: z.string().optional(),
    embeddingDimension: z.number().int().optional(),
    publicRoots: z.array(z.string().min(1)).optional(),
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

const gatewayModelIdPattern = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

function parseModelId(value: string, field: string): string {
  const model = value.trim();
  if (!gatewayModelIdPattern.test(model)) {
    throw new Error(`${field} must be an AI Gateway creator/model identifier`);
  }
  return model;
}

function parseModelChain(value: string, field: string): ModelChain {
  const models = value
    .split(",")
    .map((model) => parseModelId(model, field))
    .filter((model) => model.length > 0);

  if (models.length === 0) {
    throw new Error(`${field} must contain at least one model`);
  }

  const unique = [...new Set(models)];
  if (unique.length !== models.length) {
    throw new Error(`${field} must not repeat a model`);
  }

  const [first, ...rest] = unique;
  if (first === undefined) {
    throw new Error(`${field} must contain at least one model`);
  }
  return [first, ...rest];
}

function parsePublicRoots(roots: readonly string[] | undefined): string[] {
  return (roots ?? []).map((root) => {
    const normalized = root.replace(/^\.\//, "").replace(/\/$/, "");
    if (
      normalized.length === 0 ||
      normalized.startsWith("/") ||
      normalized.includes("\\") ||
      normalized.split("/").includes("..")
    ) {
      throw new Error(`publicRoots contains invalid repository path ${JSON.stringify(root)}`);
    }
    return normalized;
  });
}

export function parseReviewConfig(source: string | null | undefined): ReviewConfig {
  if (source === null || source === undefined || source.trim() === "") {
    return {
      model: [...defaultModels],
      embedding: defaultEmbedding,
      publicRoots: [],
      agents: { kind: "inherit" },
    };
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

  const model = parseModelChain(
    result.data.model ?? defaultModels.join(","),
    "model",
  );
  const embedding = embeddingConfigSchema.parse({
    model: parseModelId(
      result.data.embedding ?? defaultEmbedding.model,
      "embedding",
    ),
    dimension:
      result.data.embeddingDimension ?? defaultEmbedding.dimension,
  });
  const agents = result.data.agents;
  const publicRoots = parsePublicRoots(result.data.publicRoots);
  if (agents === undefined) {
    return { model, embedding, publicRoots, agents: { kind: "inherit" } };
  }
  if (typeof agents === "string") {
    return {
      model,
      embedding,
      publicRoots,
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

  return {
    model,
    embedding,
    publicRoots,
    agents: { kind: "axes", models },
  };
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
