import type {
  RunResult,
  WorkpoolOptions,
  WorkpoolRetryOptions,
} from "@convex-dev/workpool";
import { parse } from "convex-helpers/validators";
import {
  createFunctionHandle,
  internalActionGeneric,

  type DefaultFunctionArgs,
  type FunctionArgs,
  type FunctionHandle,
  type FunctionReference,
  type FunctionVisibility,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type PaginationOptions,
  type PaginationResult,
  type RegisteredAction,
  type RegisteredMutation,
  type ReturnValueForOptionalValidator,
} from "convex/server";
import type {
  Infer,
  ObjectType,
  PropertyValidators,
  Validator,
} from "convex/values";
import type { Step } from "../component/schema.js";
import type {
  EventId,
  OnCompleteArgs,
  PublicWorkflow,
  WorkflowId,
  WorkflowStep,
} from "../types.js";
import { safeFunctionName } from "./safeFunctionName.js";
import type { IdsToStrings, WorkflowComponent } from "./types.js";
import type { WorkflowCtx } from "./workflowContext.js";
import { workflowMutation } from "./workflowMutation.js";

export {
  vEventId,
  vWorkflowId,
  vWorkflowStep,
  type EventId,
  type WorkflowId,
  type WorkflowStep,
} from "../types.js";
export type { RunOptions, WorkflowCtx } from "./workflowContext.js";

/**
 * Throw this from an executor action handler to signal a rate limit.
 * The executor will wait `retryAfterMs` before retrying the task,
 * without counting it as a failure attempt.
 */
export class WorkflowRateLimitError extends Error {
  public readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Rate limited, retry after ${retryAfterMs}ms`);
    this.name = "WorkflowRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export type CallbackOptions = {
  /**
   * A mutation to run after the function succeeds, fails, or is canceled.
   * The context type is for your use, feel free to provide a validator for it.
   * e.g.
   * ```ts
   * export const completion = internalMutation({
   *  args: {
   *    workId: workIdValidator,
   *    context: v.any(),
   *    result: resultValidator,
   *  },
   *  handler: async (ctx, args) => {
   *    console.log(args.result, "Got Context back -> ", args.context, Date.now() - args.context);
   *  },
   * });
   * ```
   */
  onComplete?: FunctionReference<
    "mutation",
    FunctionVisibility,
    OnCompleteArgs
  > | null;

  /**
   * A context object to pass to the `onComplete` mutation.
   * Useful for passing data from the enqueue site to the onComplete site.
   */
  context?: unknown;
};

export type WorkflowDefinition<
  ArgsValidator extends PropertyValidators,
  ReturnsValidator extends Validator<any, "required", any> | void = any,
> = {
  args?: ArgsValidator;
  handler: (
    step: WorkflowCtx,
    args: ObjectType<ArgsValidator>,
  ) => Promise<ReturnValueForOptionalValidator<ReturnsValidator>>;
  returns?: ReturnsValidator;
  workpoolOptions?: WorkpoolRetryOptions;
};

export type WorkflowStatus =
  | { type: "inProgress"; running: IdsToStrings<Step>[] }
  | { type: "completed"; result: unknown }
  | { type: "canceled" }
  | { type: "failed"; error: string };

export class WorkflowManager {
  private batchActionNames = new Set<string>();
  private executorShards?: number;
  private executorActionHandlers = new Map<
    string,
    (ctx: GenericActionCtx<GenericDataModel>, args: any) => Promise<any>
  >();
  private executorRef: FunctionReference<"action", "internal"> | null = null;

  constructor(
    public component: WorkflowComponent,
    public options?: {
      workpoolOptions?: WorkpoolOptions;
      executorShards?: number;
    },
  ) {
    this.executorShards = options?.executorShards;
  }

  /**
   * Register an action to run inline in batch executors.
   * The action handler runs inside long-lived executor actions (no separate
   * action invocation, no 512 concurrent action limit).
   *
   * @param name - A unique name for the batch action.
   * @param opts - The action definition (args validator and handler).
   * @returns A registered action to export from your Convex module.
   */
  action<
    Args extends DefaultFunctionArgs = any,
    Returns = any,
  >(
    name: string,
    opts: {
      args: Record<string, Validator<any, any, any>>;
      handler: (
        ctx: GenericActionCtx<GenericDataModel>,
        args: Args,
      ) => Promise<Returns>;
    },
  ): RegisteredAction<"internal", Args, Returns> {
    if (!this.executorShards) {
      throw new Error(
        "WorkflowManager.action() requires `executorShards` in the constructor",
      );
    }
    // Store handler for executor to call, register name for
    // batch action detection in step.ts, return a dummy action placeholder.
    this.executorActionHandlers.set(name, opts.handler);
    this.batchActionNames.add(name);
    // Return a no-op action placeholder — the function ref must exist for
    // safeFunctionName but is never invoked directly.
    return internalActionGeneric({
      handler: async () => {
        throw new Error(
          `${name} should not be called directly — it runs inside executors`,
        );
      },
    }) as any;
  }

  /**
   * Create a long-running executor action for the sharded task queue.
   * Each executor claims tasks from a single shard, processes them
   * concurrently, and chains to the next task atomically.
   *
   * Export the return value from your Convex module, then call
   * `setExecutorRef()` with its reference.
   */
  executor(): RegisteredAction<"internal", { shard: number; epoch?: number }, null> {
    if (!this.executorShards) {
      throw new Error(
        "WorkflowManager.executor() requires `executorShards` in the constructor",
      );
    }
    const handlers = this.executorActionHandlers;
    const component = this.component;
    const numShards = this.executorShards;
    const getExecutorRef = () => this.executorRef;

    const CLAIM_LIMIT = 1500;
    const MAX_CONCURRENCY = 500;
    const POLL_BACKOFF_MS = 500;
    const POLL_BACKOFF_ACTIVE_MS = 100;
    const RESCHEDULE_MS = 8 * 60 * 1000; // 8 minutes, before 10-min action timeout
    const FLUSH_INTERVAL_MS = 100;
    const FLUSH_BATCH_SIZE = 50;
    const MAX_FLUSH_RETRIES = 5;
    const HANDOFF_POLL_MS = 500;
    const HANDOFF_SUCCESSOR_TIMEOUT_MS = 30_000;
    const HANDOFF_PREDECESSOR_TIMEOUT_MS = 30_000;

    return internalActionGeneric({
      handler: async (
        ctx: GenericActionCtx<GenericDataModel>,
        args: { shard: number; epoch?: number },
      ) => {
        const { shard, epoch } = args;
        const startTime = Date.now();
        // Stagger restarts by shard index so at most 1 shard hands off at a time.
        const JITTER_WINDOW_MS = 60_000;
        const shardSlotMs = Math.floor((shard / numShards) * JITTER_WINDOW_MS);
        const perturbMs = Math.floor(
          Math.random() * Math.floor(JITTER_WINDOW_MS / numShards),
        );
        const jitterMs = shardSlotMs + perturbMs;

        const checkEpoch = async (): Promise<boolean> => {
          const currentEpoch: number = await ctx.runQuery(
            component.taskQueue.getExecutorEpoch,
            {},
          );
          if (currentEpoch === 0) return true;
          return epoch === currentEpoch;
        };

        type Task = {
          functionType: "query" | "mutation" | "action";
          handle: string;
          args: any;
          stepId: string;
          workflowId: string;
          generationNumber: number;
          retry?: {
            maxAttempts: number;
            initialBackoffMs: number;
            base: number;
          };
        };

        type PendingResult = {
          stepId: string;
          result: RunResult;
          generationNumber: number;
          executorFinishedAt: number;
        };

        // --- Result batching with serialized replay ---
        const pendingResults: PendingResult[] = [];
        const inFlightStepIds = new Set<string>();
        let flushing = false;

        // Flush pending results in batches with inline replay.
        const flush = async () => {
          if (flushing) return;
          flushing = true;
          try {
            while (pendingResults.length > 0) {
              const batch = pendingResults.splice(0, FLUSH_BATCH_SIZE);
              try {
                await ctx.runMutation(
                  component.taskQueue.recordResultBatch,
                  {
                    items: batch.map((r) => ({
                      stepId: r.stepId,
                      result: r.result,
                      generationNumber: r.generationNumber,
                      executorFinishedAt: r.executorFinishedAt,
                    })),
                    replayInline: true,
                  },
                );
              } catch {
                pendingResults.push(...batch);
                return;
              }
              for (const item of batch) {
                inFlightStepIds.delete(item.stepId);
              }
            }
          } finally {
            flushing = false;
          }
        };

        let flushLoopRunning = true;
        const flushLoop = (async () => {
          while (flushLoopRunning) {
            await new Promise((r) => setTimeout(r, FLUSH_INTERVAL_MS));
            if (pendingResults.length > 0) {
              await flush();
            }
          }
        })();

        // --- Bounded-concurrency task processor ---
        let activeCount = 0;
        let resolveIdle: (() => void) | null = null;
        const taskBuffer: Task[] = [];

        // Per-step-type rate-limit gates: keyed by action handle so
        // different APIs (e.g. OpenAI vs Anthropic) don't gate each other.
        // Jitter spreads the thundering herd over a window after the deadline.
        const rateLimitGates = new Map<string, number>();
        const RATE_LIMIT_JITTER_MS = 10000;
        const waitForRateLimit = async (handle: string) => {
          const until = rateLimitGates.get(handle) ?? 0;
          if (until <= Date.now()) return; // no active gate
          while ((rateLimitGates.get(handle) ?? 0) > Date.now()) {
            const remaining = (rateLimitGates.get(handle) ?? 0) - Date.now();
            await new Promise((r) => setTimeout(r, remaining));
          }
          // Jitter so tasks don't all wake up at the exact same instant
          await new Promise((r) => setTimeout(r, Math.random() * RATE_LIMIT_JITTER_MS));
        };
        const setRateLimitGate = (handle: string, retryAfterMs: number) => {
          const deadline = Date.now() + retryAfterMs;
          const current = rateLimitGates.get(handle) ?? 0;
          if (deadline > current) {
            rateLimitGates.set(handle, deadline);
          }
        };

        const processTask = async (task: Task): Promise<void> => {
          const maxAttempts = Math.max(task.retry?.maxAttempts ?? 1, 1);
          const initialBackoffMs = task.retry?.initialBackoffMs ?? 125;
          const base = task.retry?.base ?? 2;

          let result: RunResult | undefined;
          let attempt = 0;
          let rateLimitRetries = 0;
          const MAX_RATE_LIMIT_RETRIES = 20;
          while (attempt < maxAttempts) {
            // Wait for any active rate-limit gate for this step type
            await waitForRateLimit(task.handle);
            try {
              let returnValue: unknown;
              switch (task.functionType) {
                case "query":
                  returnValue = await ctx.runQuery(
                    task.handle as FunctionHandle<"query">,
                    task.args,
                  );
                  break;
                case "mutation":
                  returnValue = await ctx.runMutation(
                    task.handle as FunctionHandle<"mutation">,
                    task.args,
                  );
                  break;
                case "action": {
                  const handler = handlers.get(task.handle);
                  if (!handler) {
                    result = { kind: "failed" as const, error: `Unknown action: ${task.handle}` };
                    break;
                  }
                  returnValue = await handler(ctx, task.args);
                  break;
                }
              }
              if (result?.kind === "failed") break; // unknown action — no retry
              result = { kind: "success", returnValue: returnValue ?? null };
              break;
            } catch (e) {
              if (e instanceof WorkflowRateLimitError) {
                // Set per-step-type gate — only tasks using the same
                // action handle wait; other step types keep running.
                setRateLimitGate(task.handle, e.retryAfterMs);
                rateLimitRetries++;
                if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
                  // Give up after too many rate-limit retries to avoid
                  // holding the executor indefinitely.
                  const error = `Rate limited ${rateLimitRetries} times, giving up`;
                  result = { kind: "failed", error };
                  break;
                }
                continue; // retry without consuming an attempt
              }
              const error = e instanceof Error ? e.message : `Unknown error: ${String(e)}`;
              result = { kind: "failed", error };
              attempt++;
              if (attempt < maxAttempts) {
                const backoff = initialBackoffMs * Math.pow(base, attempt - 1);
                await new Promise((r) => setTimeout(r, backoff));
              }
            }
          }
          pendingResults.push({ stepId: task.stepId, result: result!, generationNumber: task.generationNumber, executorFinishedAt: Date.now() });
        };

        const feedTask = (task: Task) => {
          if (activeCount < MAX_CONCURRENCY) {
            activeCount++;
            runTask(task);
          } else {
            taskBuffer.push(task);
          }
        };

        const runTask = (task: Task) => {
          processTask(task)
            .catch(() => {})
            .finally(() => {
              const next = taskBuffer.shift();
              if (next) {
                runTask(next);
              } else {
                activeCount--;
                if (activeCount === 0 && resolveIdle) {
                  resolveIdle();
                }
              }
            });
        };

        // Wait for all tasks to complete, then reliably flush all results.
        const waitUntilIdle = async () => {
          await new Promise<void>((resolve) => {
            if (activeCount === 0) resolve();
            else resolveIdle = resolve;
          });
          // Drain all pending results with retries.
          let retries = 0;
          while (pendingResults.length > 0) {
            await flush();
            if (pendingResults.length > 0) {
              retries++;
              if (retries >= MAX_FLUSH_RETRIES) {
                // Give up on remaining items — tasks stay in queue,
                // next executor run will re-process them.
                pendingResults.length = 0;
                break;
              }
              await new Promise((r) => setTimeout(r, 200));
            }
          }
        };

        // --- Non-blocking handshake ---
        // Move handoff cleanup into a background promise so the main
        // claiming loop starts immediately. Brief overlap of two executors
        // on the same shard is safe (claimTasks is read-only,
        // recordResultBatch checks generationNumber + inProgress).
        type Handoff = { ready: boolean; yielded: boolean } | null;
        const handoffDoc: Handoff = await ctx.runQuery(
          component.taskQueue.getHandoff,
          { shard },
        );
        const handoffCleanup: Promise<void> = (async () => {
          if (!handoffDoc || handoffDoc.yielded) {
            if (handoffDoc) {
              await ctx.runMutation(component.taskQueue.handoff, {
                shard,
                action: "clear",
              });
            }
            return;
          }
          await ctx.runMutation(component.taskQueue.handoff, {
            shard,
            action: "ready",
          });
          // Poll for yield in background.
          const predecessorDeadline =
            Date.now() + HANDOFF_PREDECESSOR_TIMEOUT_MS;
          while (Date.now() < predecessorDeadline) {
            await new Promise((r) => setTimeout(r, HANDOFF_POLL_MS));
            const state: Handoff = await ctx.runQuery(
              component.taskQueue.getHandoff,
              { shard },
            );
            if (!state || state.yielded) break;
          }
          await ctx.runMutation(component.taskQueue.handoff, {
            shard,
            action: "clear",
          });
        })().catch(() => {});
        // Main loop starts IMMEDIATELY — zero gap.

        // --- Main loop ---
        try {
          while (true) {
            if (Date.now() - startTime > RESCHEDULE_MS + jitterMs) {
              // --- Old executor handoff ---
              // Create handoff doc, schedule successor, keep claiming
              // until successor is ready, then yield and drain.
              if (await checkEpoch()) {
                await ctx.runMutation(component.taskQueue.handoff, {
                  shard,
                  action: "init",
                });
                const ref = getExecutorRef();
                if (ref) {
                  await ctx.scheduler.runAfter(0, ref, { shard, epoch });
                }
                // Handoff claiming loop: keep processing tasks until
                // the successor signals ready (or timeout).
                const successorDeadline =
                  Date.now() + HANDOFF_SUCCESSOR_TIMEOUT_MS;
                while (Date.now() < successorDeadline) {
                  if (!(await checkEpoch())) break;
                  const state: Handoff = await ctx.runQuery(
                    component.taskQueue.getHandoff,
                    { shard },
                  );
                  if (state?.ready) {
                    await ctx.runMutation(component.taskQueue.handoff, {
                      shard,
                      action: "yielded",
                    });
                    break;
                  }
                  // Continue claiming tasks (streaming) while waiting.
                  const tasks: Task[] = await ctx.runQuery(
                    component.taskQueue.claimTasks,
                    { shard, limit: CLAIM_LIMIT },
                  );
                  const newTasks = tasks.filter(t => !inFlightStepIds.has(t.stepId));
                  if (newTasks.length > 0) {
                    for (const task of newTasks) {
                      inFlightStepIds.add(task.stepId);
                      feedTask(task);
                    }
                  } else {
                    await new Promise((r) => setTimeout(r, POLL_BACKOFF_MS));
                  }
                }

              }
              // Drain: flush results may trigger replays that create new tasks.
              // Loop until the shard is fully empty. Small delay lets
              // replay sub-mutations commit before we check.
              for (let drain = 0; drain < 10; drain++) {
                await waitUntilIdle();
                await new Promise((r) => setTimeout(r, 500));
                const remaining: Task[] = await ctx.runQuery(
                  component.taskQueue.claimTasks,
                  { shard, limit: CLAIM_LIMIT },
                );
                const newRemaining = remaining.filter(t => !inFlightStepIds.has(t.stepId));
                if (newRemaining.length === 0) break;
                for (const task of newRemaining) {
                  inFlightStepIds.add(task.stepId);
                  feedTask(task);
                }
              }
              await waitUntilIdle();
              return null;
            }

            // If a newer startExecutors call happened, stop claiming
            // new work — but drain any tasks already in the shard first
            // so they aren't stranded without an executor.
            if (!(await checkEpoch())) {
              // Drain all remaining tasks including any created by replays.
              // Small delay lets replay sub-mutations commit before we check.
              for (let drain = 0; drain < 10; drain++) {
                await waitUntilIdle();
                await new Promise((r) => setTimeout(r, 500));
                const drainTasks: Task[] = await ctx.runQuery(
                  component.taskQueue.claimTasks,
                  { shard, limit: CLAIM_LIMIT },
                );
                const newDrainTasks = drainTasks.filter(t => !inFlightStepIds.has(t.stepId));
                if (newDrainTasks.length === 0) break;
                for (const task of newDrainTasks) {
                  inFlightStepIds.add(task.stepId);
                  feedTask(task);
                }
              }
              await waitUntilIdle();
              return null;
            }

            if (activeCount + taskBuffer.length < MAX_CONCURRENCY) {
              const tasks: Task[] = await ctx.runQuery(
                component.taskQueue.claimTasks,
                { shard, limit: CLAIM_LIMIT },
              );
              const newTasks = tasks.filter(t => !inFlightStepIds.has(t.stepId));
              if (newTasks.length > 0) {
                for (const task of newTasks) {
                  inFlightStepIds.add(task.stepId);
                  feedTask(task);
                }
                continue; // immediately claim more
              }
            }

            // Sleep: shorter when tasks are active, longer when truly idle.
            const sleepMs = activeCount > 0 ? POLL_BACKOFF_ACTIVE_MS : POLL_BACKOFF_MS;
            await new Promise((r) => setTimeout(r, sleepMs));
          }
        } finally {
          flushLoopRunning = false;
          await flushLoop;
          await handoffCleanup;
        }
      },
    }) as any;
  }

  /**
   * Store the FunctionReference for the executor action, used for
   * self-rescheduling before the 10-minute action timeout.
   *
   * @param ref - The function reference for the exported executor action.
   */
  setExecutorRef(ref: FunctionReference<"action", "internal">) {
    this.executorRef = ref;
  }

  /**
   * Define a new workflow.
   *
   * @param workflow - The workflow definition.
   * @returns The workflow mutation.
   */
  define<
    ArgsValidator extends PropertyValidators,
    ReturnsValidator extends Validator<unknown, "required", string> | void,
  >(
    workflow: WorkflowDefinition<ArgsValidator, ReturnsValidator>,
  ): RegisteredMutation<
    "internal",
    {
      fn: "You should not call this directly, call workflow.start instead";
      args: ObjectType<ArgsValidator>;
    },
    ReturnsValidator extends Validator<unknown, "required", string>
      ? Infer<ReturnsValidator>
      : void
  > {
    return workflowMutation(
      this.component,
      workflow,
      this.options?.workpoolOptions,
      this.batchActionNames.size > 0 ? this.batchActionNames : undefined,
    );
  }

  /**
   * Kick off a defined workflow.
   *
   * @param ctx - The Convex context.
   * @param workflow - The workflow to start (e.g. `internal.index.exampleWorkflow`).
   * @param args - The workflow arguments.
   * @returns The workflow ID.
   */
  async start<F extends FunctionReference<"mutation", "internal">>(
    ctx: RunMutationCtx,
    workflow: F,
    args: FunctionArgs<F>["args"],
    options?: CallbackOptions & {
      /**
       * By default, during creation the workflow will be initiated immediately.
       * The benefit is that you catch errors earlier (e.g. passing a bad
       * workflow reference or catch arg validation).
       *
       * With `startAsync` set to true, the workflow will be created but will
       * start asynchronously via the internal workpool.
       * You can use this to queue up a lot of work,
       * or make `start` return faster (you still get a workflowId back).
       * @default false
       */
      startAsync?: boolean;
      /** @deprecated Use `startAsync` instead. */
      validateAsync?: boolean;
    },
  ): Promise<WorkflowId> {
    const handle = await createFunctionHandle(workflow);
    const onComplete = options?.onComplete
      ? {
          fnHandle: await createFunctionHandle(options.onComplete),
          context: options.context,
        }
      : undefined;
    const workflowId = await ctx.runMutation(this.component.workflow.create, {
      workflowName: safeFunctionName(workflow),
      workflowHandle: handle,
      workflowArgs: args,
      maxParallelism: this.options?.workpoolOptions?.maxParallelism,
      onComplete,
      startAsync: options?.startAsync ?? options?.validateAsync,
      executorShards: this.executorShards,
    });
    return workflowId as unknown as WorkflowId;
  }

  /**
   * Get a workflow's status.
   *
   * @param ctx - The Convex context.
   * @param workflowId - The workflow ID.
   * @returns The workflow status.
   */
  async status(
    ctx: RunQueryCtx,
    workflowId: WorkflowId,
  ): Promise<WorkflowStatus> {
    const { workflow, inProgress } = await ctx.runQuery(
      this.component.workflow.getStatus,
      { workflowId },
    );
    const running = inProgress.map((entry) => entry.step as IdsToStrings<Step>);
    switch (workflow.runResult?.kind) {
      case undefined:
        return { type: "inProgress", running };
      case "canceled":
        return { type: "canceled" };
      case "failed":
        return { type: "failed", error: workflow.runResult.error };
      case "success":
        return { type: "completed", result: workflow.runResult.returnValue };
    }
  }

  /**
   * Cancel a running workflow.
   *
   * @param ctx - The Convex context.
   * @param workflowId - The workflow ID.
   */
  async cancel(ctx: RunMutationCtx, workflowId: WorkflowId) {
    await ctx.runMutation(this.component.workflow.cancel, {
      workflowId,
    });
  }

  /**
   * Launch executor actions for all shards. Call this once before starting
   * executor-mode workflows, or from a mutation that kicks off a benchmark.
   *
   * @param ctx - The Convex context (mutation).
   */
  async startExecutors(ctx: RunMutationCtx) {
    if (!this.executorShards || !this.executorRef) {
      throw new Error(
        "startExecutors requires executorShards and setExecutorRef",
      );
    }
    const executorHandle = await createFunctionHandle(this.executorRef);
    await ctx.runMutation(this.component.taskQueue.startExecutors, {
      executorHandle,
      numShards: this.executorShards,
    });
  }

  /**
   * List workflows, including their name, args, return value etc.
   *
   * @param ctx - The Convex context from a query, mutation, or action.
   * @param opts - How many workflows to fetch and in what order.
   *   e.g. `{ order: "desc", paginationOpts: { cursor: null, numItems: 10 } }`
   *   will get the last 10 workflows in descending order.
   *   Defaults to 100 workflows in ascending order.
   * @returns The pagination result with per-workflow data.
   */
  async list(
    ctx: RunQueryCtx,
    opts?: {
      order?: "asc" | "desc";
      paginationOpts?: PaginationOptions;
    },
  ): Promise<PaginationResult<PublicWorkflow>> {
    const workflows = await ctx.runQuery(this.component.workflow.list, {
      order: opts?.order ?? "asc",
      paginationOpts: opts?.paginationOpts ?? {
        cursor: null,
        numItems: 100,
      },
    });
    return workflows as PaginationResult<PublicWorkflow>;
  }

  /**
   * List workflows matching a specific name, including their args, return value etc.
   *
   * @param ctx - The Convex context from a query, mutation, or action.
   * @param name - The workflow name to filter by.
   * @param opts - How many workflows to fetch and in what order.
   *   e.g. `{ order: "desc", paginationOpts: { cursor: null, numItems: 10 } }`
   *   will get the last 10 workflows in descending order.
   *   Defaults to 100 workflows in ascending order.
   * @returns The pagination result with per-workflow data.
   */
  async listByName(
    ctx: RunQueryCtx,
    name: string,
    opts?: {
      order?: "asc" | "desc";
      paginationOpts?: PaginationOptions;
    },
  ): Promise<PaginationResult<PublicWorkflow>> {
    const workflows = await ctx.runQuery(this.component.workflow.listByName, {
      name,
      order: opts?.order ?? "asc",
      paginationOpts: opts?.paginationOpts ?? {
        cursor: null,
        numItems: 100,
      },
    });
    return workflows as PaginationResult<PublicWorkflow>;
  }

  /**
   * List the steps in a workflow, including their name, args, return value etc.
   *
   * @param ctx - The Convex context from a query, mutation, or action.
   * @param workflowId - The workflow ID.
   * @param opts - How many steps to fetch and in what order.
   *   e.g. `{ order: "desc", paginationOpts: { cursor: null, numItems: 10 } }`
   *   will get the last 10 steps in descending order.
   *   Defaults to 100 steps in ascending order.
   * @returns The pagination result with per-step data.
   */
  async listSteps(
    ctx: RunQueryCtx,
    workflowId: WorkflowId,
    opts?: {
      order?: "asc" | "desc";
      paginationOpts?: PaginationOptions;
    },
  ): Promise<PaginationResult<WorkflowStep>> {
    const steps = await ctx.runQuery(this.component.workflow.listSteps, {
      workflowId,
      order: opts?.order ?? "asc",
      paginationOpts: opts?.paginationOpts ?? {
        cursor: null,
        numItems: 100,
      },
    });
    return steps as PaginationResult<WorkflowStep>;
  }

  /**
   * Clean up a completed workflow's storage.
   *
   * @param ctx - The Convex context.
   * @param workflowId - The workflow ID.
   * @returns - Whether the workflow's state was cleaned up.
   */
  async cleanup(ctx: RunMutationCtx, workflowId: WorkflowId): Promise<boolean> {
    return await ctx.runMutation(this.component.workflow.cleanup, {
      workflowId,
    });
  }

  /**
   * Send an event to a workflow.
   *
   * @param ctx - From a mutation, action or workflow step.
   * @param args - Either send an event by its ID, or by name and workflow ID.
   *   If you have a validator, you must provide a value.
   *   If you provide an error string, awaiting the event will throw an error.
   */
  async sendEvent<T = null, Name extends string = string>(
    ctx: RunMutationCtx,
    args: (
      | { workflowId: WorkflowId; name: Name; id?: EventId<Name> }
      | { workflowId?: undefined; name?: Name; id: EventId<Name> }
    ) &
      (
        | { validator?: undefined; value?: T }
        | { validator: Validator<T, any, any>; value: T }
        | { error: string; value?: undefined }
      ),
  ): Promise<EventId<Name>> {
    const result: RunResult =
      "error" in args
        ? {
            kind: "failed",
            error: args.error,
          }
        : {
            kind: "success" as const,
            returnValue: args.validator
              ? parse(args.validator, args.value)
              : "value" in args
                ? args.value
                : null,
          };
    return (await ctx.runMutation(this.component.event.send, {
      eventId: args.id,
      result,
      name: args.name,
      workflowId: args.workflowId,
    })) as EventId<Name>;
  }

  /**
   * Create an event ahead of time, enabling awaiting a specific event by ID.
   * @param ctx - From an action, mutation or workflow step.
   * @param args - The name of the event and what workflow it belongs to.
   * @returns The event ID, which can be used to send the event or await it.
   */
  async createEvent<Name extends string>(
    ctx: RunMutationCtx,
    args: { name: Name; workflowId: WorkflowId },
  ): Promise<EventId<Name>> {
    return (await ctx.runMutation(this.component.event.create, {
      name: args.name,
      workflowId: args.workflowId,
    })) as EventId<Name>;
  }
}

/**
 * Define an event specification: a name and a validator.
 * This helps share definitions between workflow.sendEvent and ctx.awaitEvent.
 * e.g.
 * ```ts
 * const approvalEvent = defineEvent({
 *   name: "approval",
 *   validator: v.object({ approved: v.boolean() }),
 * });
 * ```
 * Then you can await it in a workflow:
 * ```ts
 * const result = await ctx.awaitEvent(approvalEvent);
 * ```
 * And send from somewhere else:
 * ```ts
 * await workflow.sendEvent(ctx, {
 *   ...approvalEvent,
 *   workflowId,
 *   value: { approved: true },
 * });
 * ```
 */
export function defineEvent<
  Name extends string,
  V extends Validator<unknown, "required", string>,
>(spec: { name: Name; validator: V }) {
  return spec;
}

type RunQueryCtx = {
  runQuery: GenericQueryCtx<GenericDataModel>["runQuery"];
};
type RunMutationCtx = {
  runMutation: GenericMutationCtx<GenericDataModel>["runMutation"];
};
