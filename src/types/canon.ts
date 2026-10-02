import { z } from "zod";

export const CanonStatusSchema = z.enum(["LOCKED", "DEVELOPING", "UNKNOWN", "RETIRED"]);
export const CanonTypeSchema = z.enum([
  "CHARACTER", "RELATIONSHIP", "LOCATION", "FACTION", "ITEM", "ABILITY",
  "WORLD_RULE", "TIMELINE", "PLOT_THREAD", "STYLE_RULE", "BAN_RULE", "OTHER"
]);

export const CanonEntryInputSchema = z.object({
  projectId: z.string().min(1),
  type: CanonTypeSchema,
  name: z.string().min(1),
  status: CanonStatusSchema.default("LOCKED"),
  content: z.record(z.any()),
  tags: z.array(z.string()).default([])
});

export type CanonEntryInput = z.infer<typeof CanonEntryInputSchema>;
