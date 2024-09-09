import { BaseChannel } from "async-channel";
import { GenericMutationCtx, GenericDataModel } from "convex/server";
import { convexToJson } from "convex/values";
import { JournalEntry, Step } from "../component/schema.js";
import { api } from "../component/_generated/api.js";
import { Result, UseApi } from "../types.js";

export type OriginalEnv = {
  Date: {
    now: () => number;
  };
};

export type WorkerResult =
  | { type: "handlerDone"; outcome: Result<any> }
  | { type: "executorBlocked"; entry: JournalEntry };

export type StepRequest =
  | {
      type: "function";
      functionType: "query" | "mutation" | "action";
      handle: string;
      args: any;

      resolve: (result: any) => void;
      reject: (error: any) => void;
    }
  | {
      type: "sleep";
      durationMs: number;
      resolve: (result: any) => void;
    };

export class StepExecutor {
  private nextStepNumber: number;
  constructor(
    private workflowId: string,

    private ctx: GenericMutationCtx<GenericDataModel>,
    private component: UseApi<typeof api>,
    private journalEntries: Array<JournalEntry>,
    private receiver: BaseChannel<StepRequest>,
    private originalEnv: OriginalEnv,
  ) {
    this.nextStepNumber = journalEntries.length;
  }
  async run(): Promise<WorkerResult> {
    while (true) {
      const message = await this.receiver.get();
      const entry = this.journalEntries.shift();
      if (entry) {
        this.completeMessage(message, entry);
        continue;
      }
      const newEntry = await this.pushJournalEntry(message);
      return { type: "executorBlocked", entry: newEntry };
    }
  }

  completeMessage(message: StepRequest, entry: JournalEntry) {
    if (entry.step.inProgress) {
      throw new Error(
        `Assertion failed: not blocked but have in-progress journal entry`,
      );
    }
    switch (message.type) {
      case "function": {
        if (entry.step.type !== "function") {
          throw new Error(
            `Journal entry mismatch: ${message.type} !== ${entry.step.type}`,
          );
        }
        const stepArgsJson = JSON.stringify(convexToJson(entry.step.args));
        const messageArgsJson = JSON.stringify(convexToJson(message.args));
        if (stepArgsJson !== messageArgsJson) {
          throw new Error(
            `Journal entry mismatch: ${entry.step.args} !== ${message.args}`,
          );
        }
        if (entry.step.outcome === undefined) {
          throw new Error(
            `Assertion failed: no outcome for completed function call`,
          );
        }
        if (entry.step.outcome.type === "success") {
          message.resolve(entry.step.outcome.result);
        } else {
          message.reject(new Error(entry.step.outcome.error));
        }
        return;
      }
      case "sleep": {
        if (entry.step.type !== "sleep") {
          throw new Error(
            `Journal entry mismatch: ${message.type} !== ${entry.step.type}`,
          );
        }
        if (entry.step.durationMs !== message.durationMs) {
          throw new Error(
            `Journal entry mismatch: ${entry.step.durationMs} !== ${message.durationMs}`,
          );
        }
        message.resolve(undefined);
        return;
      }
    }
  }

  async pushJournalEntry(message: StepRequest): Promise<JournalEntry> {
    const stepNumber = this.nextStepNumber;
    this.nextStepNumber += 1;
    let step: Step;
    switch (message.type) {
      case "function": {
        step = {
          type: "function",
          inProgress: true,
          functionType: message.functionType,
          handle: message.handle,
          args: message.args,
          outcome: undefined,
          startedAt: this.originalEnv.Date.now(),
          completedAt: undefined,
        };
        break;
      }
      case "sleep": {
        step = {
          type: "sleep",
          inProgress: true,
          durationMs: message.durationMs,
          deadline: this.originalEnv.Date.now() + message.durationMs,
        };
        break;
      }
    }
    const entry = await this.ctx.runMutation(
      this.component.index.pushJournalEntry,
      {
        workflowId: this.workflowId,
        stepNumber,
        step,
      },
    );
    return entry;
  }
}
