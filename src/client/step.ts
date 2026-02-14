import type {
  BatchWorkpool,
  RetryBehavior,
  RunResult,
  WorkpoolOptions,
} from "@convex-dev/workpool";
import { BaseChannel } from "async-channel";
import {
  createFunctionHandle,
  type FunctionReference,
  type FunctionType,
  type FunctionVisibility,
  type GenericDataModel,
  type GenericMutationCtx,
} from "convex/server";
import { convexToJson, type Value } from "convex/values";
import {
  type JournalEntry,
  journalEntrySize,
  type Step,
  valueSize,
} from "../component/schema.js";
import type { WorkflowComponent } from "./types.js";
import { MAX_JOURNAL_SIZE } from "../shared.js";
import type { EventId, SchedulerOptions } from "../types.js";
import { safeFunctionName } from "./safeFunctionName.js";

export type WorkerResult =
  | { type: "handlerDone"; runResult: RunResult }
  | { type: "executorBlocked" };

export type StepRequest = {
  name: string;
  target:
    | {
        kind: "function";
        functionType: FunctionType;
        function: FunctionReference<FunctionType, FunctionVisibility>;
        args: unknown;
      }
    | {
        kind: "event";
        args: { eventId?: EventId };
      }
    | {
        kind: "workflow";
        function: FunctionReference<"mutation", "internal">;
        args: unknown;
      };
  retry: RetryBehavior | boolean | undefined;
  schedulerOptions: SchedulerOptions;

  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
};

export class StepExecutor {
  private journalEntrySize: number;
  private remainingMessageCount: number;

  constructor(
    private workflowId: string,
    private generationNumber: number,
    private ctx: GenericMutationCtx<GenericDataModel>,
    private component: WorkflowComponent,
    private journalEntries: Array<JournalEntry>,
    private receiver: BaseChannel<StepRequest>,
    private now: number,
    private workpoolOptions: WorkpoolOptions | undefined,
    private batch?: BatchWorkpool,
  ) {
    this.journalEntrySize = journalEntries.reduce(
      (size, entry) => size + journalEntrySize(entry),
      0,
    );
    // Cache the total message count for getGenerationState (called on every
    // Date.now()). A batchGroup entry covers `count` messages; others cover 1.
    this.remainingMessageCount = journalEntries.reduce(
      (count, entry) =>
        count + (entry.step.kind === "batchGroup" ? entry.step.count : 1),
      0,
    );

    if (this.journalEntrySize > MAX_JOURNAL_SIZE) {
      // This should never happen, but we'll throw an error just in case.
      throw new Error(journalSizeError(this.journalEntrySize, this.workflowId));
    }
  }
  async run(): Promise<WorkerResult> {
    while (true) {
      const message = await this.receiver.get();
      // In the future we can correlate the calls to entries by handle, args,
      // etc. instead of just ordering. As is, the fn order can't change.
      const entry = this.journalEntries[0];

      // Handle batchGroup replay: one entry covers N messages.
      if (entry && entry.step.kind === "batchGroup") {
        this.journalEntries.shift();
        this.remainingMessageCount -= entry.step.count;
        if (entry.step.inProgress) {
          throw new Error(
            `Assertion failed: batchGroup entry still in progress`,
          );
        }
        // Load all individual results from the batchResults table.
        const results = (await this.ctx.runQuery(
          this.component.journal.loadBatchResults,
          { batchStepId: entry._id },
        )) as unknown as Array<{
          index: number;
          result: { kind: string; returnValue?: unknown; error?: string };
        }>;
        results.sort((a, b) => a.index - b.index);

        // Validate results count and index integrity.
        if (results.length !== entry.step.count) {
          throw new Error(
            `Batch result count mismatch for ${entry._id}: ` +
              `expected ${entry.step.count} results but got ${results.length}`,
          );
        }
        for (let i = 0; i < results.length; i++) {
          if (results[i].index !== i) {
            throw new Error(
              `Batch result index mismatch for ${entry._id}: ` +
                `expected index ${i} at position ${i} but got index ${results[i].index}`,
            );
          }
        }

        // Resolve the first message (already dequeued).
        this._completeBatchItem(message, results[0]);

        // Dequeue and resolve the remaining count - 1 messages.
        for (let i = 1; i < entry.step.count; i++) {
          const msg = await this.receiver.get();
          this._completeBatchItem(msg, results[i]);
        }
        continue;
      }

      // Regular replay: one entry per message.
      if (entry) {
        this.journalEntries.shift();
        this.remainingMessageCount--;
        this.completeMessage(message, entry);
        continue;
      }
      const messages = [message];
      const size = this.receiver.bufferSize;
      for (let i = 0; i < size; i++) {
        const message = await this.receiver.get();
        messages.push(message);
      }
      const entries = await this.startSteps(messages);
      if (entries.every((entry) => entry.step.runResult)) {
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          this.completeMessage(messages[i], entry);
        }
        continue;
      }
      return {
        type: "executorBlocked",
      };
    }
  }

  getGenerationState() {
    // Use cached message count (decremented as entries are consumed in run()).
    if (this.remainingMessageCount <= this.receiver.bufferSize) {
      return { now: this.now, latest: true };
    }
    // Find the entry that corresponds to the buffer boundary.
    let accumulated = 0;
    for (const entry of this.journalEntries) {
      const entryMessages =
        entry.step.kind === "batchGroup" ? entry.step.count : 1;
      if (accumulated + entryMessages > this.receiver.bufferSize) {
        return { now: entry.step.startedAt, latest: false };
      }
      accumulated += entryMessages;
    }
    return { now: this.now, latest: true };
  }

  completeMessage(message: StepRequest, entry: JournalEntry) {
    if (entry.step.inProgress) {
      throw new Error(
        `Assertion failed: not blocked but have in-progress journal entry`,
      );
    }
    const stepArgsJson = JSON.stringify(convexToJson(entry.step.args));
    const messageArgsJson = JSON.stringify(
      convexToJson(message.target.args as Value),
    );
    if (stepArgsJson !== messageArgsJson) {
      throw new Error(
        `Journal entry mismatch: ${entry.step.args} !== ${message.target.args}`,
      );
    }
    if (entry.step.runResult === undefined) {
      throw new Error(
        `Assertion failed: no outcome for completed function call`,
      );
    }
    switch (entry.step.runResult.kind) {
      case "success":
        message.resolve(entry.step.runResult.returnValue);
        break;
      case "failed":
        message.reject(new Error(entry.step.runResult.error));
        break;
      case "canceled":
        message.reject(new Error("Canceled"));
        break;
    }
  }

  private _completeBatchItem(
    message: StepRequest,
    result: { index: number; result: { kind: string; returnValue?: unknown; error?: string } },
  ) {
    switch (result.result.kind) {
      case "success":
        message.resolve(result.result.returnValue);
        break;
      case "failed":
        message.reject(new Error(result.result.error));
        break;
      case "canceled":
        message.reject(new Error("Canceled"));
        break;
    }
  }

  async startSteps(messages: StepRequest[]): Promise<JournalEntry[]> {
    if (!this.batch) {
      return this._startStepsRegular(messages);
    }

    // Classify each message as batch-eligible or regular.
    const isBatch = messages.map((message) => {
      const target = message.target;
      return (
        target.kind === "function" &&
        target.functionType === "action" &&
        this.batch!.isRegistered(safeFunctionName(target.function))
      );
    });

    if (isBatch.every((b) => !b)) {
      return this._startStepsRegular(messages);
    }

    // Process contiguous groups in original order so step numbers are assigned
    // sequentially matching message order. This is critical for correctness on
    // resume: journal entries are loaded by stepNumber, and the handler replays
    // messages in original order, so the two must match.
    const allEntries: JournalEntry[] = [];
    let i = 0;
    while (i < messages.length) {
      const groupIsBatch = isBatch[i];
      const groupStart = i;
      while (i < messages.length && isBatch[i] === groupIsBatch) {
        i++;
      }
      const groupMessages = messages.slice(groupStart, i);
      const groupEntries = groupIsBatch
        ? await this._startStepsBatch(groupMessages)
        : await this._startStepsRegular(groupMessages);
      allEntries.push(...groupEntries);
    }
    return allEntries;
  }

  private async _startStepsRegular(
    messages: StepRequest[],
  ): Promise<JournalEntry[]> {
    const steps = await Promise.all(
      messages.map(async (message) => {
        const step = await this._buildStep(message);
        return {
          retry: message.retry,
          schedulerOptions: message.schedulerOptions,
          step,
        };
      }),
    );
    const entries = (await this.ctx.runMutation(
      this.component.journal.startSteps,
      {
        workflowId: this.workflowId,
        generationNumber: this.generationNumber,
        steps,
        workpoolOptions: this.workpoolOptions,
      },
    )) as unknown as JournalEntry[];
    this._checkJournalSize(entries);
    return entries;
  }

  private async _startStepsBatch(
    messages: StepRequest[],
  ): Promise<JournalEntry[]> {
    // Create a single batchGroup step doc for all N messages.
    const { entry, onCompleteHandle } =
      (await this.ctx.runMutation(
        this.component.journal.startBatchGroupStep,
        {
          workflowId: this.workflowId,
          generationNumber: this.generationNumber,
          count: messages.length,
          workpoolOptions: this.workpoolOptions,
        },
      )) as unknown as {
        entry: JournalEntry;
        onCompleteHandle: string;
      };
    this._checkJournalSize([entry]);

    // Build all batch tasks upfront.
    const maxWorkers = (this.batch as any).options?.maxWorkers ?? 10;
    const tasks = messages.map((message, i) => {
      const target = message.target;
      if (target.kind !== "function") {
        throw new Error(
          `Assertion failed: batch step has unexpected target kind "${target.kind}"`,
        );
      }
      const handlerName = this.batch!.resolveHandlerName(
        safeFunctionName(target.function),
      );
      if (!handlerName) {
        throw new Error(
          `Assertion failed: batch step has no handler for "${safeFunctionName(target.function)}" despite passing isRegistered`,
        );
      }
      return {
        name: handlerName,
        args: target.args as Record<string, unknown>,
        slot: Math.floor(Math.random() * maxWorkers),
        onComplete: {
          fnHandle: onCompleteHandle,
          context: {
            batchStepId: entry._id,
            index: i,
          },
        },
        retryBehavior: undefined,
      };
    });

    // First enqueue triggers batchConfig setup (executor start).
    await this.batch!.enqueueByHandle(
      this.ctx,
      tasks[0].name,
      tasks[0].args,
      { onComplete: tasks[0].onComplete, retry: messages[0].retry },
    );

    // Batch-enqueue the rest directly via the component mutation.
    const remaining = tasks.slice(1);
    const BATCH_SIZE = 500;
    for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
      const chunk = remaining.slice(i, i + BATCH_SIZE);
      await this.ctx.runMutation(this.batch!.component.batch.enqueueBatch, {
        tasks: chunk,
        batchConfig: undefined,
      });
    }
    // Return single entry — always inProgress, triggers executorBlocked.
    return [entry];
  }

  private async _buildStep(message: StepRequest) {
    const commonFields = {
      inProgress: true,
      name: message.name,
      args: message.target.args,
      argsSize: valueSize(message.target.args as Value),
      runResult: undefined,
      startedAt: this.now,
      completedAt: undefined,
    } satisfies Omit<Step, "kind">;
    const target = message.target;
    return target.kind === "function"
      ? {
          kind: "function" as const,
          functionType: target.functionType,
          handle: await createFunctionHandle(target.function),
          ...commonFields,
        }
      : target.kind === "workflow"
        ? {
            kind: "workflow" as const,
            handle: await createFunctionHandle(target.function),
            ...commonFields,
          }
        : {
            kind: "event" as const,
            eventId: target.args.eventId,
            ...commonFields,
            args: target.args,
          };
  }

  private _checkJournalSize(entries: JournalEntry[]) {
    for (const entry of entries) {
      this.journalEntrySize += journalEntrySize(entry);
      if (this.journalEntrySize > MAX_JOURNAL_SIZE) {
        throw new Error(
          journalSizeError(this.journalEntrySize, this.workflowId) +
            ` The failing step was ${entry.step.name} (${entry._id})`,
        );
      }
    }
  }
}

function journalSizeError(size: number, workflowId: string): string {
  const lines = [
    `Workflow ${workflowId} journal size limit exceeded (${size} bytes > ${MAX_JOURNAL_SIZE} bytes).`,
    "Consider breaking up the workflow into multiple runs, using smaller step \
    arguments or return values, or using fewer steps.",
  ];
  return lines.join("\n");
}
