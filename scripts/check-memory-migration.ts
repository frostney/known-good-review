import { spawn } from "bun";

// Run with the production deploy key in the trusted build environment.
// The native Convex inline-query sandbox is read-only and cannot access secrets.
const query = `
const jobs = await ctx.db.system.query("_scheduled_functions").take(1001);
const repositories = await ctx.db.query("repositoryMemory").take(1001);
const ingestions = await ctx.db.query("memoryIngestions").take(1001);
if ([jobs, repositories, ingestions].some(rows => rows.length > 1000)) {
  throw new Error("Migration inspection exceeded its bound; inspect and drain with pagination before deployment");
}
const activeJobs = jobs.filter(job => ["pending", "inProgress"].includes(job.state.kind));
const activeRepositories = repositories.filter(row => row.deleting || row.pendingEmbedding);
const activeIngestions = ingestions.filter(row => ["pending", "processing", "awaiting_reembed"].includes(row.status));
if (activeJobs.length || activeRepositories.length || activeIngestions.length) {
  throw new Error("Memory migration requires drained work: " + JSON.stringify({
    scheduled: activeJobs.length, repositories: activeRepositories.length, ingestions: activeIngestions.length
  }));
}
return { drained: true, inspected: { jobs: jobs.length, repositories: repositories.length, ingestions: ingestions.length } };
`;

if (!process.env.CONVEX_DEPLOY_KEY) {
  throw new Error("Run migration:check in the trusted environment with its existing Convex deploy key");
}
const command = spawn(["bun", "x", "convex", "run", "--inline-query", query], {
  stdout: "inherit",
  stderr: "inherit",
  timeout: 60_000,
});
process.exit(await command.exited);
