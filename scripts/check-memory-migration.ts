import { spawn } from "bun";
import { z } from "zod";

const jobSchema = z.object({ state: z.object({ kind: z.enum(["pending", "inProgress", "success", "failed", "canceled"]) }) });
const repositorySchema = z.object({ deleting: z.boolean(), pendingEmbedding: z.unknown().optional() });
const ingestionSchema = z.object({ status: z.enum(["pending", "processing", "awaiting_reembed", "complete", "failed"]) });

export function inspectMemoryMigration(tables: {
  jobs: unknown; repositories: unknown; ingestions: unknown;
}) {
  const jobs = z.array(jobSchema).max(1000).parse(tables.jobs);
  const repositories = z.array(repositorySchema).max(1000).parse(tables.repositories);
  const ingestions = z.array(ingestionSchema).max(1000).parse(tables.ingestions);
  const active = {
    scheduled: jobs.filter(job => ["pending", "inProgress"].includes(job.state.kind)).length,
    repositories: repositories.filter(row => row.deleting || row.pendingEmbedding !== undefined).length,
    ingestions: ingestions.filter(row => ["pending", "processing", "awaiting_reembed"].includes(row.status)).length,
  };
  if (Object.values(active).some(count => count > 0)) {
    throw new Error(`Memory migration requires drained work: ${JSON.stringify(active)}`);
  }
  return { drained: true, inspected: { jobs: jobs.length, repositories: repositories.length, ingestions: ingestions.length } };
}

export function parseMemoryTable(output: string, error: string, code: number): unknown {
  if (code !== 0) throw new Error(`Could not inspect memory table: ${error.trim()}`);
  if (!output.trim() && error.trim() === "There are no documents in this table.") return [];
  return JSON.parse(output);
}

async function readTable(table: string): Promise<unknown> {
  // Use the existing deploy key's native table-read permission. Never log rows,
  // which may contain repository findings; only emit aggregate gate results.
  const command = spawn(["bun", "x", "convex", "data", table, "--limit", "1001", "--format", "json"], {
    stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
  const [output, error, code] = await Promise.all([
    new Response(command.stdout).text(), new Response(command.stderr).text(), command.exited,
  ]);
  return parseMemoryTable(output, error, code);
}

if (import.meta.main) {
  if (!process.env.CONVEX_DEPLOY_KEY) {
    throw new Error("Run migration:check in the trusted environment with its existing Convex deploy key");
  }
  const [jobs, repositories, ingestions] = await Promise.all([
    readTable("_scheduled_functions"), readTable("repositoryMemory"), readTable("memoryIngestions"),
  ]);
  console.log(JSON.stringify(inspectMemoryMigration({ jobs, repositories, ingestions })));
}
