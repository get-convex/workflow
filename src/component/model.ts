import { QueryCtx } from "./_generated/server.js";

export async function getWorkflow(
  ctx: QueryCtx,
  workflowIdStr: string,
  expectedGenerationNumber: number | null,
) {
  const workflowId = ctx.db.normalizeId("workflows", workflowIdStr);
  if (!workflowId) {
    throw new Error(`Invalid workflow ID: ${workflowIdStr}`);
  }
  const workflow = await ctx.db.get(workflowId);
  if (!workflow) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }
  if (
    expectedGenerationNumber !== null &&
    workflow.generationNumber !== expectedGenerationNumber
  ) {
    throw new Error(
      `Invalid generation number: ${expectedGenerationNumber} for workflow ${workflow.name} (${workflowId})`,
    );
  }
  return workflow;
}

export async function getJournalEntry(ctx: QueryCtx, journalIdStr: string) {
  const journalId = ctx.db.normalizeId("steps", journalIdStr);
  if (!journalId) {
    throw new Error(`Invalid journal ID: ${journalIdStr}`);
  }
  const journalEntry = await ctx.db.get(journalId);
  if (!journalEntry) {
    throw new Error(`Journal entry not found: ${journalId}`);
  }
  return journalEntry;
}
