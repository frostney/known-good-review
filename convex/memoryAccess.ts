import { v } from "convex/values";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";

export async function installationRemoved(ctx: QueryCtx, installationId: number) {
  return (await ctx.db.query("memoryUninstalls")
    .withIndex("by_installation_id", (q) => q.eq("installationId", installationId)).unique()) !== null;
}

async function accessRecord(ctx: QueryCtx, installationId: number, repositoryId: string) {
  return ctx.db.query("memoryAccess").withIndex("by_installation_and_repository", (q) =>
    q.eq("installationId", installationId).eq("repositoryId", repositoryId)).unique();
}

export async function admissionIsCurrent(ctx: QueryCtx, args: {
  installationId: number; repositoryId: string; memoryAdmission: string;
}) {
  if (await installationRemoved(ctx, args.installationId)) return false;
  const access = await accessRecord(ctx, args.installationId, args.repositoryId);
  return access !== null && args.memoryAdmission === `${access._id}:${access.generation}`;
}

// Capture the generation BEFORE checking GitHub access. A later removal then
// invalidates every review already in flight, including its delayed HTTP writes.
export const captureAdmission = internalMutation({
  args: { installationId: v.number(), repositoryId: v.string() },
  returns: v.object({ receipt: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    if (await installationRemoved(ctx, args.installationId)) return { receipt: null };
    const access = await accessRecord(ctx, args.installationId, args.repositoryId);
    if (access) return { receipt: `${access._id}:${access.generation}` };
    const id = await ctx.db.insert("memoryAccess", { ...args, generation: 0 });
    return { receipt: `${id}:0` };
  },
});

export async function revokeRepositoryAdmission(ctx: MutationCtx, args: {
  installationId: number; repositoryId: string; deliveryId: string;
}): Promise<boolean> {
  const delivered = await ctx.db.query("memoryDeletionDeliveries")
    .withIndex("by_installation_repository_delivery", (q) => q.eq("installationId", args.installationId)
      .eq("repositoryId", args.repositoryId).eq("deliveryId", args.deliveryId)).unique();
  if (delivered) return false;
  await ctx.db.insert("memoryDeletionDeliveries", args);
  const access = await accessRecord(ctx, args.installationId, args.repositoryId);
  if (access) await ctx.db.patch(access._id, { generation: access.generation + 1 });
  else await ctx.db.insert("memoryAccess", { installationId: args.installationId, repositoryId: args.repositoryId, generation: 1 });
  return true;
}
