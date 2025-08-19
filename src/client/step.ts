import { BaseChannel } from "async-channel";
import {
  type GenericMutationCtx,
  type GenericDataModel,
  type FunctionType,
  type FunctionReference,
  createFunctionHandle,
} from "convex/server";
import { convexToJson, Value } from "convex/values";
import {
  type JournalEntry,
  journalEntrySize,
  valueSize,
} from "../component/schema.js";
import { api } from "../component/_generated/api.js";
import type { UseApi } from "../types.js";
import type {
  RetryBehavior,
  WorkpoolOptions,
  RunResult,
} from "@convex-dev/workpool";
import type { SchedulerOptions } from "./types.js";

export type OriginalEnv = {
  Date: {
    now: () => number;
  };
};

export type WorkerResult =
  | { type: "handlerDone"; runResult: RunResult }
  | { type: "executorBlocked" };

export type StepRequest = {
  name: string;
  functionType: FunctionType;
  function: FunctionReference<FunctionType, "internal">;
  args: unknown;
  retry: RetryBehavior | boolean | undefined;
  schedulerOptions: SchedulerOptions;

  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
};

const MAX_JOURNAL_SIZE = 1 << 20;

export class StepExecutor {
  private journalEntrySize: number;

  constructor(
    private workflowId: string,
    private generationNumber: number,
    private ctx: GenericMutationCtx<GenericDataModel>,
    private component: UseApi<typeof api>,
    private journalEntries: Array<JournalEntry>,
    private receiver: BaseChannel<StepRequest>,
    private originalEnv: OriginalEnv,
    private workpoolOptions: WorkpoolOptions | undefined,
  ) {
    this.journalEntrySize = journalEntries.reduce(
      (size, entry) => size + journalEntrySize(entry),
      0,
    );
  }
  async run(): Promise<WorkerResult> {
    // eslint-disable-next-line no-constant-condition
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
      // TODO: is this too late?
      if (this.journalEntrySize > MAX_JOURNAL_SIZE) {
        message.reject(journalSizeError(this.journalEntrySize));
        continue;
      }
      const messages = [message];
      const size = this.receiver.bufferSize;
      for (let i = 0; i < size; i++) {
        const message = await this.receiver.get();
        messages.push(message);
      }
      for (const message of messages) {
        await this.startStep(message);
      }
      return {
        type: "executorBlocked",
      };
    }
  }

  completeMessage(message: StepRequest, entry: JournalEntry) {
    if (entry.step.inProgress) {
      throw new Error(
        `Assertion failed: not blocked but have in-progress journal entry`,
      );
    }
    const stepArgsJson = JSON.stringify(convexToJson(entry.step.args));
    const messageArgsJson = JSON.stringify(convexToJson(message.args as Value));
    if (stepArgsJson !== messageArgsJson) {
      throw new Error(
        `Journal entry mismatch: ${entry.step.args} !== ${message.args}`,
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

  async startStep(message: StepRequest): Promise<JournalEntry> {
    const step = {
      inProgress: true,
      name: message.name,
      functionType: message.functionType,
      handle: await createFunctionHandle(message.function),
      args: message.args,
      argsSize: valueSize(message.args as Value),
      outcome: undefined,
      startedAt: this.originalEnv.Date.now(),
      completedAt: undefined,
    };
    const entry = (await this.ctx.runMutation(
      this.component.journal.startStep,
      {
        workflowId: this.workflowId,
        generationNumber: this.generationNumber,
        step,
        name: message.name,
        retry: message.retry,
        workpoolOptions: this.workpoolOptions,
        schedulerOptions: message.schedulerOptions,
      },
    )) as JournalEntry;
    this.journalEntrySize += journalEntrySize(entry);
    return entry;
  }
}

function journalSizeError(size: number): Error {
  const lines = [
    `Workflow journal size limit exceeded (${size} bytes > ${MAX_JOURNAL_SIZE} bytes).`,
    "Consider breaking up the workflow into multiple runs, using smaller step \
    arguments or return values, or using fewer steps.",
  ];
  return new Error(lines.join("\n"));
}
