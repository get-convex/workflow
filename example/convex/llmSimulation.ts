import { v } from "convex/values";
import { WorkflowId, WorkflowManager, vWorkflowId } from "@convex-dev/workflow";
import { BatchWorkpool } from "@convex-dev/workpool";
import { vResultValidator } from "@convex-dev/workpool";
import { internal } from "./_generated/api.js";
import { components } from "./_generated/api.js";
import { internalMutation, mutation } from "./_generated/server.js";
import { Id } from "./_generated/dataModel.js";

// --- BatchWorkpool setup ---

const batch = new BatchWorkpool(components.workpool, {
  maxWorkers: 2,
  maxConcurrencyPerWorker: 200,
});

export const executor = batch.executor();
batch.setExecutorRef(internal.llmSimulation.executor);

// --- Simulated IO actions ---

const SIMULATED_IO_MS = 20_000;

function simulateIO(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const generateOutline = batch.action("generateOutline", {
  args: { topic: v.string() },
  handler: async (_ctx, args): Promise<string[]> => {
    console.log(`[outline] Generating outline for "${args.topic}"...`);
    await simulateIO(SIMULATED_IO_MS);
    const sections: string[] = [];
    for (let i = 1; i <= 200; i++) {
      sections.push(`${args.topic} - Section ${i}`);
    }
    console.log(`[outline] Generated ${sections.length} section titles`);
    return sections;
  },
});

export const generateSection = batch.action("generateSection", {
  args: { title: v.string(), index: v.number() },
  handler: async (_ctx, args): Promise<string> => {
    console.log(`[section ${args.index}] Generating "${args.title}"...`);
    await simulateIO(SIMULATED_IO_MS);
    const content = `Content for "${args.title}": Lorem ipsum dolor sit amet, consectetur adipiscing elit. This is simulated LLM output for section ${args.index}.`;
    console.log(`[section ${args.index}] Done`);
    return content;
  },
});

export const generateSummary = batch.action("generateSummary", {
  args: { sectionCount: v.number(), topic: v.string() },
  handler: async (_ctx, args): Promise<string> => {
    console.log(
      `[summary] Summarizing ${args.sectionCount} sections for "${args.topic}"...`,
    );
    await simulateIO(SIMULATED_IO_MS);
    const summary = `Summary of "${args.topic}": This document contains ${args.sectionCount} sections covering the topic in depth. Generated via simulated LLM pipeline.`;
    console.log(`[summary] Done`);
    return summary;
  },
});

// --- Workflow managers ---

const regularWorkflow = new WorkflowManager(components.workflow);

const batchedWorkflow = new WorkflowManager(components.workflow, {
  batch,
});

// --- Shared workflow definition factory ---

function defineContentPipeline(manager: WorkflowManager) {
  return manager.define({
    args: { topic: v.string(), simulationId: v.id("llmSimulations") },
    returns: v.string(),
    handler: async (step, args): Promise<string> => {
      // Step 1: Generate outline (~20s)
      const sections = await step.runAction(
        internal.llmSimulation.generateOutline,
        { topic: args.topic },
      );

      // Step 2: Generate 200 sections in parallel (~20s with batch, much longer with regular)
      const sectionResults = await Promise.all(
        (sections as string[]).map((title: string, index: number) =>
          step.runAction(internal.llmSimulation.generateSection, {
            title,
            index,
          }),
        ),
      );

      // Step 3: Generate summary (~20s)
      const summary = await step.runAction(
        internal.llmSimulation.generateSummary,
        {
          sectionCount: sectionResults.length,
          topic: args.topic,
        },
      );

      // Step 4: Save result
      await step.runMutation(internal.llmSimulation.saveResult, {
        simulationId: args.simulationId,
        result: summary as string,
      });

      return summary as string;
    },
  });
}

export const regularPipeline = defineContentPipeline(regularWorkflow);
export const batchedPipeline = defineContentPipeline(batchedWorkflow);

// --- Internal mutations ---

export const saveResult = internalMutation({
  args: {
    simulationId: v.id("llmSimulations"),
    result: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.simulationId, { result: args.result });
  },
});

export const pipelineCompleted = internalMutation({
  args: {
    workflowId: vWorkflowId,
    result: vResultValidator,
    context: v.any(),
  },
  handler: async (ctx, args) => {
    const simulationId = args.context as Id<"llmSimulations">;
    const simulation = await ctx.db.get(simulationId);
    if (!simulation) {
      console.error(`Simulation not found: ${simulationId}`);
      return;
    }
    const completedAt = Date.now();
    await ctx.db.patch(simulation._id, { completedAt });
    const elapsed = ((completedAt - simulation.startedAt) / 1000).toFixed(1);
    console.log(
      `Pipeline completed [${simulation.mode}]: ${elapsed}s elapsed`,
    );
  },
});

// --- Public start mutations (callable from dashboard) ---

export const startRegularPipeline = mutation({
  args: {
    topic: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const topic = args.topic ?? "The History of Computing";
    const simulationId = await ctx.db.insert("llmSimulations", {
      mode: "regular",
      topic,
      startedAt: Date.now(),
    });
    const workflowId: WorkflowId = await regularWorkflow.start(
      ctx,
      internal.llmSimulation.regularPipeline,
      { topic, simulationId },
      {
        onComplete: internal.llmSimulation.pipelineCompleted,
        context: simulationId,
        startAsync: true,
      },
    );
    console.log(`Started regular pipeline: ${workflowId}`);
    return workflowId;
  },
});

export const startBatchedPipeline = mutation({
  args: {
    topic: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const topic = args.topic ?? "The History of Computing";
    const simulationId = await ctx.db.insert("llmSimulations", {
      mode: "batched",
      topic,
      startedAt: Date.now(),
    });
    const workflowId: WorkflowId = await batchedWorkflow.start(
      ctx,
      internal.llmSimulation.batchedPipeline,
      { topic, simulationId },
      {
        onComplete: internal.llmSimulation.pipelineCompleted,
        context: simulationId,
        startAsync: true,
      },
    );
    console.log(`Started batched pipeline: ${workflowId}`);
    return workflowId;
  },
});
