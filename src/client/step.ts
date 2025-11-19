import type {
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
  valueSize,
} from "../component/schema.js";
import type { WorkflowComponent } from "./types.js";
import { MAX_JOURNAL_SIZE } from "../shared.js";
import type { EventId, SchedulerOptions } from "../types.js";

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

  constructor(
    private workflowId: string,
    private generationNumber: number,
    private ctx: GenericMutationCtx<GenericDataModel>,
    private component: WorkflowComponent,
    private journalEntries: Array<JournalEntry>,
    private receiver: BaseChannel<StepRequest>,
    private now: number,
    private workpoolOptions: WorkpoolOptions | undefined,
  ) {
    this.journalEntrySize = journalEntries.reduce(
      (size, entry) => size + journalEntrySize(entry),
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
      const entry = this.journalEntries.shift();
      // why not to run queries inline: they fetch too much data internally
      if (entry) {
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
    if (this.journalEntries.length <= this.receiver.bufferSize) {
      return { now: this.now, latest: true };
    }
    return {
      // We use the next entry's startedAt, since we're in code just before that
      // step is invoked. We use the bufferSize, since multiple steps may be
      // currently enqueued in one generation, but the code after it has already
      // started executing.
      now: this.journalEntries[this.receiver.bufferSize].step.startedAt,
      latest: false,
    };
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

  async startSteps(messages: StepRequest[]): Promise<JournalEntry[]> {
    const steps = await Promise.all(
      messages.map(async (message) => {
        const commonFields = {
          inProgress: true,
          name: message.name,
          args: message.target.args,
          argsSize: valueSize(message.target.args as Value),
          outcome: undefined,
          startedAt: this.now,
          completedAt: undefined,
        };
        const target = message.target;
        const step =
          target.kind === "function"
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
    )) as JournalEntry[];
    for (const entry of entries) {
      this.journalEntrySize += journalEntrySize(entry);
      if (this.journalEntrySize > MAX_JOURNAL_SIZE) {
        throw new Error(
          journalSizeError(this.journalEntrySize, this.workflowId) +
            ` The failing step was ${entry.step.name} (${entry._id})`,
        );
      }
    }
    return entries;
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
