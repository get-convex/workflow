import { v } from "convex/values";
import { WorkflowManager } from "@convex-dev/workflow";
// BatchWorkpool not yet published in @convex-dev/workpool — batch mode disabled.
// import { BatchWorkpool } from "@convex-dev/workpool";
import { components, internal } from "./_generated/api.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server.js";
import { vWorkflowId, WorkflowRateLimitError, type WorkflowId } from "@convex-dev/workflow";
import { vResultValidator } from "@convex-dev/workpool";
// Dynamic import — only loaded when benchmarkMode is "real".
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _anthropicModule: any = null;
async function getAnthropicModule() {
  if (!_anthropicModule) {
    _anthropicModule = await import("@anthropic-ai/sdk");
  }
  return _anthropicModule;
}

// ── Shared constants ──
const SIMULATE_BASE_MS = 8000;
const SIMULATE_JITTER_MS = 4000;

type StepResult = {
  result: string;
  executorStartedAt: number;
  readyAt: number;
  inputTokens?: number;
  outputTokens?: number;
};

async function simulateWork(
  index: number,
  task: string,
  input?: string,
): Promise<StepResult> {
  const executorStartedAt = Date.now();
  const jitterMs = Math.floor(Math.random() * SIMULATE_JITTER_MS);
  await new Promise((resolve) =>
    setTimeout(resolve, SIMULATE_BASE_MS + jitterMs),
  );
  return {
    result: `[item=${index} task=${task}] result based on: ${input ?? "none"}`,
    executorStartedAt,
    readyAt: Date.now(),
  };
}

// ── Real Claude LLM call ──

const TOPICS = [
  "The impact of quantum computing on modern cryptography and data security",
  "How CRISPR gene editing is transforming agricultural practices worldwide",
  "The role of microplastics in ocean ecosystems and marine food chains",
  "Autonomous vehicle safety standards and regulatory challenges across countries",
  "The economics of space tourism and its potential impact on the aerospace industry",
  "How artificial intelligence is changing drug discovery and pharmaceutical research",
  "The relationship between social media algorithms and political polarization",
  "Renewable energy storage solutions and their role in grid modernization",
  "The ethics of facial recognition technology in public surveillance systems",
  "How remote work is reshaping urban planning and commercial real estate markets",
  "The potential of nuclear fusion as a practical energy source by 2050",
  "Blockchain technology applications beyond cryptocurrency in supply chain management",
  "The neuroscience of sleep deprivation and its effects on cognitive performance",
  "How vertical farming could address food security in growing urban populations",
  "The cultural and economic impact of generative AI on creative industries",
  "Deep sea mining regulations and environmental concerns in international waters",
  "The role of gut microbiome research in personalized medicine approaches",
  "How satellite internet constellations are changing global connectivity patterns",
  "The psychological effects of virtual reality on empathy and social behavior",
  "Carbon capture technology scalability and its role in climate change mitigation",
];

function buildPrompt(task: string, index: number, input?: string): string {
  const topic = TOPICS[index % TOPICS.length];
  switch (task) {
    case "extract":
      return (
        `You are a research assistant. Analyze the following topic and extract exactly 3 key claims or assertions that could be independently verified. Be specific and concise.\n\n` +
        `Topic: "${topic}"\n\n` +
        `Return exactly 3 numbered claims, each on its own line.`
      );
    case "analyze-a":
      return (
        `You are a fact-checking analyst. For each claim below, briefly assess its factual accuracy based on your knowledge. Rate each as likely accurate, partially accurate, or likely inaccurate, with a one-sentence explanation.\n\n` +
        `Claims:\n${input}\n\n` +
        `Be concise — one line per claim.`
      );
    case "analyze-b":
      return (
        `You are a logical reasoning analyst. For each claim below, assess whether it is logically coherent, whether it contains any assumptions or logical gaps, and how it relates to the other claims.\n\n` +
        `Claims:\n${input}\n\n` +
        `Be concise — one line per claim.`
      );
    case "summarize":
      return (
        `You are a research editor. Combine the following two analyses into a concise 2-3 sentence executive summary that captures the overall assessment.\n\n` +
        `${input}\n\n` +
        `Write only the summary, nothing else.`
      );
    default:
      return `Respond briefly about: ${input ?? topic}`;
  }
}

async function getAnthropicClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not configured.\n" +
        "npx convex env set ANTHROPIC_API_KEY sk-ant-****",
    );
  }
  const mod = await getAnthropicModule();
  const Anthropic = mod.default;
  // SDK handles short 429 waits (under 60s) with exponential backoff.
  // Our WorkflowRateLimitError + shared gate handles the rest.
  return new Anthropic({ apiKey, maxRetries: 10 });
}

// Module-level rate-limit gate shared across all concurrent callClaude
// calls within this executor shard. First call to hit a 429 sets the
// deadline; every other call checks it before making an API request.
let claudeRateLimitUntil = 0;

async function callClaude(
  index: number,
  task: string,
  input?: string,
): Promise<StepResult> {
  // Check the shared gate — if we're rate-limited, don't even try,
  // just tell the executor to sleep and retry us later.
  const now = Date.now();
  if (claudeRateLimitUntil > now) {
    throw new WorkflowRateLimitError(claudeRateLimitUntil - now);
  }

  const executorStartedAt = Date.now();
  const client = await getAnthropicClient();
  const mod = await getAnthropicModule();
  const SdkRateLimitError = mod.RateLimitError;

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 16,
      messages: [
        { role: "user", content: "Reply with exactly: hello world" },
      ],
    });
    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    return {
      result: text,
      executorStartedAt,
      readyAt: Date.now(),
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  } catch (err) {
    // Match rate limit errors by instanceof OR status code (instanceof
    // can fail across dynamic import module boundaries).
    const isRateLimit = err instanceof SdkRateLimitError
      || (err as { status?: number })?.status === 429
      || (err instanceof Error && /rate.limit|429|too.many.requests/i.test(err.message));
    if (isRateLimit) {
      const rateLimitErr = err as { headers?: { get?: (k: string) => string | null } };
      const retryAfterStr = rateLimitErr.headers?.get?.("retry-after");
      const waitMs = retryAfterStr
        ? Math.ceil(parseFloat(retryAfterStr) * 1000)
        : 30_000;
      // Set the shared gate so other calls don't even attempt
      const deadline = Date.now() + waitMs;
      if (deadline > claudeRateLimitUntil) {
        claudeRateLimitUntil = deadline;
      }
      throw new WorkflowRateLimitError(waitMs);
    }
    throw err;
  }
}

async function doWork(
  mode: "simulated" | "real",
  index: number,
  task: string,
  input?: string,
): Promise<StepResult> {
  if (mode === "real") {
    return callClaude(index, task, input);
  }
  return simulateWork(index, task, input);
}

// ═══════════════════════════════════════════════════════════════════════════
// STANDARD MODE — each action is a separate Convex action invocation
// ═══════════════════════════════════════════════════════════════════════════

const standardWorkflow = new WorkflowManager(components.workflow, {
  workpoolOptions: {
    maxParallelism: 200,
  },
});

const vBenchmarkMode = v.union(v.literal("simulated"), v.literal("real"));
type BenchmarkMode = "simulated" | "real";

export const standardSimulateLLM = internalAction({
  args: {
    index: v.number(),
    task: v.string(),
    input: v.optional(v.string()),
    benchmarkMode: vBenchmarkMode,
  },
  handler: async (_ctx, { index, task, input, benchmarkMode }) => {
    return await doWork(benchmarkMode, index, task, input);
  },
});

export const standardResearchWorkflow = standardWorkflow.define({
  args: { index: v.number(), benchmarkMode: vBenchmarkMode },
  returns: v.object({ summary: v.string() }),
  handler: async (step, args): Promise<{ summary: string }> => {
    const extracted = (await step.runAction(
      internal.benchmark.standardSimulateLLM,
      { index: args.index, task: "extract", benchmarkMode: args.benchmarkMode },
    )) as StepResult;

    const [analysisA, analysisB] = (await Promise.all([
      step.runAction(internal.benchmark.standardSimulateLLM, {
        index: args.index,
        task: "analyze-a",
        input: extracted.result,
        benchmarkMode: args.benchmarkMode,
      }),
      step.runAction(internal.benchmark.standardSimulateLLM, {
        index: args.index,
        task: "analyze-b",
        input: extracted.result,
        benchmarkMode: args.benchmarkMode,
      }),
    ])) as [StepResult, StepResult];

    const summary = (await step.runAction(
      internal.benchmark.standardSimulateLLM,
      {
        index: args.index,
        task: "summarize",
        input: `${analysisA.result} ||| ${analysisB.result}`,
        benchmarkMode: args.benchmarkMode,
      },
    )) as StepResult;

    return { summary: summary.result };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// BATCH MODE — disabled (BatchWorkpool not yet published in @convex-dev/workpool)
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// EXECUTOR MODE — sharded task queue with executor-driven chaining
// ═══════════════════════════════════════════════════════════════════════════

const executorWorkflow = new WorkflowManager(components.workflow, {
  workpoolOptions: { maxParallelism: 200 },
  executorShards: 100,
});

export const executorSimulateLLM = executorWorkflow.action(
  "executorSimulateLLM",
  {
    args: {
      index: v.number(),
      task: v.string(),
      input: v.optional(v.string()),
      benchmarkMode: vBenchmarkMode,
    },
    handler: async (_ctx, { index, task, input, benchmarkMode }) =>
      doWork(benchmarkMode, index, task, input),
  },
);

export const executorResearchWorkflow = executorWorkflow.define({
  args: { index: v.number(), benchmarkMode: vBenchmarkMode },
  returns: v.object({ summary: v.string() }),
  handler: async (step, args): Promise<{ summary: string }> => {
    const extracted = (await step.runAction(
      internal.benchmark.executorSimulateLLM,
      { index: args.index, task: "extract", benchmarkMode: args.benchmarkMode },
    )) as StepResult;

    const [analysisA, analysisB] = (await Promise.all([
      step.runAction(internal.benchmark.executorSimulateLLM, {
        index: args.index,
        task: "analyze-a",
        input: extracted.result,
        benchmarkMode: args.benchmarkMode,
      }),
      step.runAction(internal.benchmark.executorSimulateLLM, {
        index: args.index,
        task: "analyze-b",
        input: extracted.result,
        benchmarkMode: args.benchmarkMode,
      }),
    ])) as [StepResult, StepResult];

    const summary = (await step.runAction(
      internal.benchmark.executorSimulateLLM,
      {
        index: args.index,
        task: "summarize",
        input: `${analysisA.result} ||| ${analysisB.result}`,
        benchmarkMode: args.benchmarkMode,
      },
    )) as StepResult;

    return { summary: summary.result };
  },
});

export const executorAction = executorWorkflow.executor();
executorWorkflow.setExecutorRef(internal.benchmark.executorAction);

// ═══════════════════════════════════════════════════════════════════════════
// onComplete callback — writes workflow result to app table
// ═══════════════════════════════════════════════════════════════════════════

export const onBenchmarkComplete = internalMutation({
  args: {
    workflowId: vWorkflowId,
    context: v.any(),
    result: vResultValidator,
  },
  handler: async (ctx, { workflowId, result }) => {
    await ctx.db.insert("benchmarkResults", {
      workflowId: workflowId as WorkflowId,
      result:
        result.kind === "success" ? result.returnValue : { error: result },
      completedAt: Date.now(),
    });
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// Benchmark launchers & status
// ═══════════════════════════════════════════════════════════════════════════

const BATCH_CREATE_SIZE = 25;

export const startBenchmarkBatch = internalMutation({
  args: {
    mode: v.union(
      v.literal("standard"),
      v.literal("executor"),
    ),
    benchmarkMode: vBenchmarkMode,
    count: v.number(),
    offset: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { mode, benchmarkMode, count, offset }) => {
    const wf =
      mode === "executor"
        ? executorWorkflow
        : standardWorkflow;
    const def =
      mode === "executor"
        ? internal.benchmark.executorResearchWorkflow
        : internal.benchmark.standardResearchWorkflow;
    for (let i = 0; i < count; i++) {
      await wf.start(ctx, def, { index: offset + i, benchmarkMode }, {
        startAsync: true,
        onComplete: internal.benchmark.onBenchmarkComplete,
        context: null,
      });
    }
  },
});

// Orchestrator mutation: schedules all batch creation mutations + starts executors.
export const startBenchmark = internalMutation({
  args: {
    mode: v.union(
      v.literal("standard"),
      v.literal("executor"),
    ),
    benchmarkMode: v.optional(vBenchmarkMode),
    count: v.number(),
    skipExecutorStart: v.optional(v.boolean()),
  },
  returns: v.object({ startedAt: v.number(), vizUrl: v.string() }),
  handler: async (ctx, { mode, benchmarkMode: bm, count, skipExecutorStart }) => {
    const benchmarkMode = bm ?? "simulated";
    const startedAt = Date.now();

    if (count <= BATCH_CREATE_SIZE) {
      // Small count — create inline, no scheduler delay.
      const wf = mode === "executor" ? executorWorkflow : standardWorkflow;
      const def = mode === "executor"
        ? internal.benchmark.executorResearchWorkflow
        : internal.benchmark.standardResearchWorkflow;
      for (let i = 0; i < count; i++) {
        await wf.start(ctx, def, { index: i, benchmarkMode }, {
          startAsync: true,
          onComplete: internal.benchmark.onBenchmarkComplete,
          context: null,
        });
      }
    } else {
      // Convex limits scheduled functions to 1000 per mutation.
      // startExecutors is scheduled separately (uses 1 slot).
      const maxBatches = skipExecutorStart ? 999 : 998;
      const batchSize = Math.max(BATCH_CREATE_SIZE, Math.ceil(count / maxBatches));
      for (let offset = 0; offset < count; offset += batchSize) {
        const batchCount = Math.min(batchSize, count - offset);
        await ctx.scheduler.runAfter(
          0,
          internal.benchmark.startBenchmarkBatch,
          { mode, benchmarkMode, count: batchCount, offset },
        );
      }
    }

    if (mode === "executor" && !skipExecutorStart) {
      await ctx.scheduler.runAfter(0, internal.benchmark.startExecutors, {});
    }
    const siteUrl = process.env.CONVEX_SITE_URL ?? process.env.CONVEX_CLOUD_URL?.replace(".convex.cloud", ".convex.site") ?? "";
    const vizUrl = siteUrl + "/benchmark-viz?after=" + startedAt;
    return { startedAt, vizUrl };
  },
});

export const startExecutors = internalMutation({
  args: { numShards: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx) => {
    await executorWorkflow.startExecutors(ctx);
  },
});

// Stop all running executors by bumping the epoch without starting new ones.
export const stopExecutors = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.runMutation(components.workflow.taskQueue.bumpEpoch, {});
    return null;
  },
});

// Fail all pending tasks across all shards. Each shard's tasks get marked as
// failed and replay entries inserted so workflows can complete.
export const failAllPendingTasks = internalAction({
  args: {},
  handler: async (ctx) => {
    const NUM_SHARDS = 100;
    const BATCH_LIMIT = 500;
    let totalFailed = 0;
    for (let shard = 0; shard < NUM_SHARDS; shard++) {
      let shardDone = false;
      while (!shardDone) {
        const result: { failed: number } = await ctx.runMutation(
          components.workflow.taskQueue.failPendingTasks,
          { shard, limit: BATCH_LIMIT },
        );
        totalFailed += result.failed;
        if (result.failed < BATCH_LIMIT) shardDone = true;
      }
    }
    console.log(`failAllPendingTasks: failed ${totalFailed} tasks across ${NUM_SHARDS} shards`);
  },
});

// Cancel a batch of running workflows by name. Call repeatedly until running=0.
export const cancelBatch = internalMutation({
  args: { name: v.string(), limit: v.number() },
  returns: v.object({ canceled: v.number(), remaining: v.number() }),
  handler: async (ctx, { name, limit }) => {
    const wf = standardWorkflow;
    const page = await wf.listByName(ctx, name, {
      order: "desc",
      paginationOpts: { cursor: null, numItems: limit },
    });
    let canceled = 0;
    for (const w of page.page) {
      if (!w.runResult) {
        try {
          await wf.cancel(ctx, w.workflowId);
          canceled++;
        } catch {
          // already completed/canceled, skip
        }
      }
    }
    // Count remaining running
    const check = await wf.listByName(ctx, name, {
      order: "desc",
      paginationOpts: { cursor: null, numItems: 1000 },
    });
    const remaining = check.page.filter((w) => !w.runResult).length;
    return { canceled, remaining };
  },
});

// Cancel running workflows in asc order (oldest first) to reach stuck workflows.
export const cancelOldest = internalMutation({
  args: { name: v.string(), limit: v.number() },
  returns: v.object({ canceled: v.number(), total: v.number() }),
  handler: async (ctx, { name, limit }) => {
    const wf = standardWorkflow;
    const page = await wf.listByName(ctx, name, {
      order: "asc",
      paginationOpts: { cursor: null, numItems: limit },
    });
    let canceled = 0;
    for (const w of page.page) {
      if (!w.runResult) {
        try {
          await wf.cancel(ctx, w.workflowId);
          canceled++;
        } catch {
          // already completed/canceled, skip
        }
      }
    }
    return { canceled, total: page.page.length };
  },
});

// Cleanup (delete) completed/canceled workflows in asc order.
export const cleanupOldest = internalMutation({
  args: { name: v.string(), limit: v.number() },
  returns: v.object({ cleaned: v.number(), total: v.number() }),
  handler: async (ctx, { name, limit }) => {
    const wf = standardWorkflow;
    const page = await wf.listByName(ctx, name, {
      order: "asc",
      paginationOpts: { cursor: null, numItems: limit },
    });
    let cleaned = 0;
    for (const w of page.page) {
      if (w.runResult) {
        try {
          await wf.cleanup(ctx, w.workflowId);
          cleaned++;
        } catch {
          // skip
        }
      }
    }
    return { cleaned, total: page.page.length };
  },
});


export const diagnoseExecutor = internalQuery({
  args: {},
  returns: v.object({
    taskQueueCounts: v.array(v.object({ shard: v.number(), count: v.number() })),
    totalTasks: v.number(),
    executorEpoch: v.number(),
  }),
  handler: async (ctx) => {
    return await ctx.runQuery(components.workflow.taskQueue.diagnose, {
      numShards: 100,
    });
  },
});

// Paginated count action — loops over countByNamePage across multiple query
// executions to avoid the 16MB read limit at 20k+ workflows.
export const benchmarkStatus = internalAction({
  args: {
    name: v.string(),
    createdAfter: v.optional(v.number()),
  },
  returns: v.object({
    total: v.number(),
    completed: v.number(),
    failed: v.number(),
    running: v.number(),
  }),
  handler: async (ctx, { name, createdAfter }) => {
    let completed = 0;
    let failed = 0;
    let running = 0;
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone) {
      const page: {
        completed: number; failed: number; running: number;
        continueCursor: string; isDone: boolean;
      } = await ctx.runQuery(
        components.workflow.workflow.countByNamePage,
        { name, createdAfter, paginationOpts: { cursor, numItems: 500 } },
      );
      completed += page.completed;
      failed += page.failed;
      running += page.running;
      cursor = page.continueCursor;
      isDone = page.isDone;
    }
    const total = completed + failed + running;
    return { total, completed, failed, running };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// Public queries for benchmark-viz.html (ConvexHttpClient needs public fns)
// ═══════════════════════════════════════════════════════════════════════════

import { paginationOptsValidator } from "convex/server";

export const benchmarkTimeline = query({
  args: {
    name: v.string(),
    createdAfter: v.optional(v.number()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { name, createdAfter, paginationOpts }) => {
    return await ctx.runQuery(
      components.workflow.workflow.timelinePage,
      { name, createdAfter, paginationOpts },
    );
  },
});


export const creationTimeBuckets = internalQuery({
  args: {
    name: v.string(),
    createdAfter: v.number(),
    bucketMs: v.number(),
  },
  handler: async (ctx, { name, createdAfter, bucketMs }) => {
    return await ctx.runQuery(
      components.workflow.workflow.creationTimeBuckets,
      { name, createdAfter, bucketMs },
    );
  },
});

// Diagnostic: analyze WHERE delays happen in the tail workflows.
// Computes queue wait, execution time, and inter-step gap for worst-case workflows.
export const diagnoseTail = internalAction({
  args: {
    createdAfter: v.number(),
    tailCount: v.optional(v.number()), // how many slowest workflows to analyze
  },
  handler: async (ctx, { createdAfter, tailCount: rawTailCount }) => {
    const tailCount = rawTailCount ?? 200;
    // Paginate through all workflows to find the slowest ones.
    const allWorkflows: Array<{
      id: string;
      createdAt: number;
      totalDurationMs: number;
      steps: Array<{
        stepNumber: number;
        name: string;
        startedAt: number;
        completedAt?: number;
        executionStartedAt?: number;
      }>;
    }> = [];

    let cursor: string | null = null;
    let isDone = false;
    while (!isDone) {
      const page: any = await ctx.runQuery(
        components.workflow.workflow.timelinePage,
        {
          name: "benchmark:executorResearchWorkflow",
          createdAfter,
          paginationOpts: { cursor, numItems: 200 },
        },
      );
      for (const wf of page.page) {
        const lastStep = wf.steps[wf.steps.length - 1];
        const completedAt = lastStep?.completedAt ?? 0;
        allWorkflows.push({
          ...wf,
          totalDurationMs: completedAt ? completedAt - wf.createdAt : -1,
        });
      }
      cursor = page.continueCursor;
      isDone = page.isDone;
    }

    // Sort by total duration descending, take the tail.
    allWorkflows.sort((a, b) => b.totalDurationMs - a.totalDurationMs);
    const tail = allWorkflows.slice(0, tailCount);

    // Analyze each tail workflow's step timing.
    type StepDelay = {
      name: string;
      queueWaitMs: number; // executionStartedAt - startedAt
      executionMs: number; // completedAt - executionStartedAt
      gapFromPrevMs: number; // startedAt - prevStep.completedAt
    };

    const analyzed = tail.map((wf) => {
      const stepDelays: StepDelay[] = [];
      for (let i = 0; i < wf.steps.length; i++) {
        const step = wf.steps[i];
        const prevStep = i > 0 ? wf.steps[i - 1] : null;
        stepDelays.push({
          name: step.name,
          queueWaitMs: step.executionStartedAt
            ? step.executionStartedAt - step.startedAt
            : -1,
          executionMs:
            step.completedAt && step.executionStartedAt
              ? step.completedAt - step.executionStartedAt
              : -1,
          gapFromPrevMs:
            prevStep?.completedAt
              ? step.startedAt - prevStep.completedAt
              : 0,
        });
      }
      return {
        id: wf.id,
        createdAt: wf.createdAt,
        totalDurationMs: wf.totalDurationMs,
        offsetFromBenchStartMs: wf.createdAt - createdAfter,
        stepDelays,
      };
    });

    // Aggregate stats across the tail.
    const allQueueWaits: number[] = [];
    const allExecutionTimes: number[] = [];
    const allGaps: number[] = [];
    for (const wf of analyzed) {
      for (const s of wf.stepDelays) {
        if (s.queueWaitMs >= 0) allQueueWaits.push(s.queueWaitMs);
        if (s.executionMs >= 0) allExecutionTimes.push(s.executionMs);
        if (s.gapFromPrevMs > 0) allGaps.push(s.gapFromPrevMs);
      }
    }

    const percentile = (arr: number[], p: number) => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
      return sorted[idx];
    };

    return {
      totalWorkflows: allWorkflows.length,
      tailSize: tail.length,
      fastestMs: allWorkflows[allWorkflows.length - 1]?.totalDurationMs ?? 0,
      slowestMs: allWorkflows[0]?.totalDurationMs ?? 0,
      p50Ms: percentile(allWorkflows.map(w => w.totalDurationMs), 0.5),
      p90Ms: percentile(allWorkflows.map(w => w.totalDurationMs), 0.9),
      p99Ms: percentile(allWorkflows.map(w => w.totalDurationMs), 0.99),
      tailStats: {
        queueWait: {
          p50: percentile(allQueueWaits, 0.5),
          p90: percentile(allQueueWaits, 0.9),
          p99: percentile(allQueueWaits, 0.99),
          max: percentile(allQueueWaits, 1),
        },
        execution: {
          p50: percentile(allExecutionTimes, 0.5),
          p90: percentile(allExecutionTimes, 0.9),
          p99: percentile(allExecutionTimes, 0.99),
          max: percentile(allExecutionTimes, 1),
        },
        interStepGap: {
          p50: percentile(allGaps, 0.5),
          p90: percentile(allGaps, 0.9),
          p99: percentile(allGaps, 0.99),
          max: percentile(allGaps, 1),
        },
      },
      // Show top 10 worst workflows with full detail.
      worstWorkflows: analyzed.slice(0, 10),
    };
  },
});

// Diagnostic: find stuck workflows (no runResult) via component timeline.
export const diagnoseStuck = internalAction({
  args: {
    name: v.string(),
    createdAfter: v.number(),
  },
  handler: async (ctx, { name, createdAfter }) => {
    const stuck: any[] = [];
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone && stuck.length < 10) {
      const page: any = await ctx.runQuery(
        components.workflow.workflow.timelinePage,
        { name, createdAfter, paginationOpts: { cursor, numItems: 200 } },
      );
      for (const wf of page.page) {
        if (!wf.runResult) {
          // Get step details through admin query
          const status: any = await ctx.runQuery(
            components.workflow.workflow.getStatus,
            { workflowId: wf.id },
          );
          stuck.push({
            id: wf.id,
            createdAt: wf.createdAt,
            steps: wf.steps,
            status,
          });
        }
        if (stuck.length >= 10) break;
      }
      cursor = page.continueCursor;
      isDone = page.isDone;
    }
    return { count: stuck.length, stuck };
  },
});

// Priority analysis: check if earlier-created workflows complete before later ones.
export const priorityAnalysis = internalAction({
  args: {
    name: v.string(),
    createdAfter: v.number(),
  },
  handler: async (ctx, { name, createdAfter }) => {
    // Paginate through all workflows, collect creation + completion times.
    const data: Array<{ createdAt: number; completedAt: number }> = [];
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone) {
      const page: any = await ctx.runQuery(
        components.workflow.workflow.timelinePage,
        { name, createdAfter, paginationOpts: { cursor, numItems: 200 } },
      );
      for (const wf of page.page) {
        if (!wf.runResult) continue;
        const lastStep = wf.steps[wf.steps.length - 1];
        const completedAt = lastStep?.completedAt ?? 0;
        if (completedAt) data.push({ createdAt: wf.createdAt, completedAt });
      }
      cursor = page.continueCursor;
      isDone = page.isDone;
    }

    // Sort by creation time, split into deciles.
    data.sort((a, b) => a.createdAt - b.createdAt);
    const decileSize = Math.ceil(data.length / 10);
    const deciles = [];
    for (let i = 0; i < 10; i++) {
      const slice = data.slice(i * decileSize, (i + 1) * decileSize);
      if (slice.length === 0) continue;
      const durations = slice.map(d => d.completedAt - d.createdAt);
      const completedAts = slice.map(d => d.completedAt - createdAfter);
      durations.sort((a, b) => a - b);
      completedAts.sort((a, b) => a - b);
      deciles.push({
        decile: i,
        count: slice.length,
        createdRangeSec: `${((slice[0].createdAt - createdAfter) / 1000).toFixed(1)}-${((slice[slice.length - 1].createdAt - createdAfter) / 1000).toFixed(1)}`,
        avgDurationSec: Math.round(durations.reduce((s, d) => s + d, 0) / durations.length / 1000),
        medianDurationSec: Math.round(durations[Math.floor(durations.length / 2)] / 1000),
        avgCompletedAtSec: Math.round(completedAts.reduce((s, d) => s + d, 0) / completedAts.length / 1000),
        medianCompletedAtSec: Math.round(completedAts[Math.floor(completedAts.length / 2)] / 1000),
      });
    }

    return { total: data.length, deciles };
  },
});

// Manual replay for stuck workflows — calls component's replayIfReady.
export const manualReplay = internalMutation({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    workflowHandle: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(components.workflow.taskQueue.replayIfReady, args);
  },
});

// Paginated status page — one page per query execution (stays under 16MB).
// The viz calls this in a loop via fetch, accumulating counts across pages.
export const benchmarkStatusPage = query({
  args: {
    name: v.string(),
    createdAfter: v.optional(v.number()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { name, createdAfter, paginationOpts }) => {
    return await ctx.runQuery(
      components.workflow.workflow.countByNamePage,
      { name, createdAfter, paginationOpts },
    );
  },
});
