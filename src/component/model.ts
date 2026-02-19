import type { Id } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";

export async function getWorkflow(
  ctx: QueryCtx,
  workflowId: Id<"workflows">,
  expectedGenerationNumber: number,
) {
  const workflow = await ctx.db.get("workflows", workflowId);
  if (!workflow) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }
  if (workflow.generationNumber !== expectedGenerationNumber) {
    throw new Error(
      `Invalid generation number: ${expectedGenerationNumber} for workflow ${workflow.name} (${workflowId})`,
    );
  }
  return workflow;
}
