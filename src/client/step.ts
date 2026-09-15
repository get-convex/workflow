import type { RetryBehavior, WorkpoolOptions } from "@convex-dev/workpool";
import { BaseChannel } from "async-channel";
import {
  createFunctionHandle,
  type FunctionReference,
  type FunctionType,
  type FunctionVisibility,
  type GenericDataModel,
  type GenericMutationCtx,
} from "convex/server";
import { convexToJson, getConvexSize, type Value } from "convex/values";
import { type JournalEntry, type Step } from "../component/schema.js";
import type {
  IdsToStrings,
  RunResult,
  TransactionLimits,
  WorkflowComponent,
} from "./types.js";
import { MAX_JOURNAL_SIZE, formatErrorWithStack } from "../shared.js";
import type { EventId, SchedulerOptions } from "../types.js";
import { pick } from "convex-helpers";

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
        args: Record<string, unknown>;
      }
    | {
        kind: "event";
        args: { eventId?: EventId };
      }
    | {
        kind: "workflow";
        function: FunctionReference<"mutation", "internal">;
        args: Record<string, unknown>;
      }
    | {
        kind: "sleep";
        args: Record<string, never>;
      };
  retry: RetryBehavior | boolean | undefined;
  inline: boolean;
  unstableArgs: boolean;
  transactionLimits: TransactionLimits | undefined;
  schedulerOptions: SchedulerOptions;

  resolve: (result: RunResult) => void;
};

// A step.journal.consumeNext() request: consume the next recorded journal
// entry without executing anything, returning the entry itself.
export type ConsumeRequest = {
  consume: true;
  expectedName: string | undefined;
  resolve: (entry: JournalEntry) => void;
  reject: (error: Error) => void;
};

// A read at the current journal position. It is never persisted as a step.
export type SizeRequest = {
  getSize: true;
  resolve: (size: number) => void;
};

export type ExecutorRequest = StepRequest | ConsumeRequest | SizeRequest;

export class ExecutorChannel {
  private channel: BaseChannel<ExecutorRequest>;
  requestedSteps = 0;

  constructor(capacity: number) {
    this.channel = new BaseChannel(capacity);
  }

  get bufferSize() {
    return this.channel.bufferSize;
  }

  get() {
    return this.channel.get();
  }

  push(request: ExecutorRequest) {
    if (!("getSize" in request)) {
      // Include requests waiting for channel capacity, but not metadata reads.
      this.requestedSteps++;
      if ("consume" in request) {
        const reject = request.reject;
        request = {
          ...request,
          reject: (error) => {
            this.requestedSteps--;
            reject(error);
          },
        };
      }
    }
    return this.channel.push(request);
  }
}

export class StepExecutor {
  // Internal accounting for the journal size limit, including pending steps.
  private journalSize: number = 0;
  private replayedSteps = 0;

  constructor(
    private workflowId: string,
    private generationNumber: number,
    private ctx: GenericMutationCtx<GenericDataModel>,
    private component: WorkflowComponent,
    private journalEntries: Array<JournalEntry>,
    private receiver: ExecutorChannel,
    private now: number,
    private workpoolOptions: WorkpoolOptions | undefined,
    private definedVersion: number = 0,
  ) {}
  async run(): Promise<WorkerResult> {
    let sizeRequest: SizeRequest | undefined;
    while (true) {
      const message = sizeRequest ?? (await this.receiver.get());
      sizeRequest = undefined;
      if ("getSize" in message) {
        // Earlier steps have all completed, either inline or on replay.
        // Later recorded entries have not contributed to journalSize yet.
        message.resolve(this.journalSize);
        continue;
      }
      if ("consume" in message) {
        this.consumeMessage(message);
        continue;
      }
      // In the future we can correlate the calls to entries by handle, args,
      // etc. instead of just ordering. As is, the fn order can't change.
      const entry = this.journalEntries.shift();
      if (entry) {
        this.replayedSteps++;
        this.journalSize += getConvexSize(entry);
        this.completeMessage(message, entry);
        continue;
      }
      const messages = [message];
      const size = this.receiver.bufferSize;
      for (let i = 0; i < size; i++) {
        const message = await this.receiver.get();
        if ("getSize" in message) {
          // Flush the preceding steps before answering the read. If they
          // block, replay recreates this request after they finish.
          sizeRequest = message;
          break;
        }
        if ("consume" in message) {
          // The journal is empty (we're at the frontier), so this rejects.
          this.consumeMessage(message);
          continue;
        }
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
    const pendingSteps = this.receiver.requestedSteps - this.replayedSteps;
    if (this.journalEntries.length <= pendingSteps) {
      return { now: this.now, version: this.definedVersion, latest: true };
    }
    // We use the next entry's startedAt / version, since we're in code just
    // before that step is invoked. Count requested steps rather than channel
    // messages so size reads do not advance version or deterministic time.
    const next = this.journalEntries[pendingSteps];
    return {
      now: next.step.startedAt,
      version: next.step.version ?? 0,
      latest: false,
    };
  }

  getJournalState() {
    return {
      version: this.getGenerationState().version,
    };
  }

  consumeMessage(message: ConsumeRequest) {
    const expected = message.expectedName
      ? ` (expected "${message.expectedName}")`
      : "";
    // Peek: only remove the entry once every check below has passed, so a
    // caught mismatch leaves the journal aligned for the rest of the replay.
    const entry = this.journalEntries[0];
    if (!entry) {
      message.reject(
        new Error(
          `consumeNext: no recorded step to consume${expected}. ` +
            `The workflow is at the live frontier. Only call ` +
            `step.journal.consumeNext() when replaying history known to have ` +
            `recorded the step, e.g. gated on step.journal.getVersion().`,
        ),
      );
      return;
    }
    if (entry.step.inProgress) {
      message.reject(
        new Error(
          `Assertion failed: not blocked but have in-progress journal entry`,
        ),
      );
      return;
    }
    if (
      message.expectedName !== undefined &&
      entry.step.name !== message.expectedName
    ) {
      message.reject(
        new Error(
          `Journal entry mismatch: consumeNext${expected} found step ` +
            `"${entry.step.name}" (step ${entry.stepNumber}) instead.`,
        ),
      );
      return;
    }
    this.journalEntries.shift();
    this.replayedSteps++;
    this.journalSize += getConvexSize(entry);
    message.resolve(entry);
  }

  completeMessage(message: StepRequest, entry: JournalEntry) {
    if (entry.step.inProgress) {
      throw new Error(
        `Assertion failed: not blocked but have in-progress journal entry`,
      );
    }
    const stepFields = pick(
      entry.step,
      message.unstableArgs ? ["name", "kind"] : ["name", "kind", "args"],
    );
    const messageFields = message.unstableArgs
      ? { name: message.name, kind: message.target.kind }
      : {
          name: message.name,
          kind: message.target.kind,
          args: message.target.args as Value,
        };
    const stepJson = JSON.stringify(convexToJson(stepFields));
    const messageJson = JSON.stringify(convexToJson(messageFields));
    if (stepJson !== messageJson) {
      throw new Error(
        `Journal entry mismatch:\n\n${stepJson}\n\n!==\n\n${messageJson}`,
      );
    }
    if (entry.step.runResult === undefined) {
      throw new Error(
        `Assertion failed: no outcome for completed function call`,
      );
    }
    message.resolve(entry.step.runResult);
  }

  async startSteps(messages: StepRequest[]): Promise<JournalEntry[]> {
    const steps = await Promise.all(
      messages.map(async (message) => {
        const args = message.target.args ?? {};
        const target = message.target;

        let runResult: RunResult | undefined;
        if (message.inline) {
          if (target.kind !== "function" || target.functionType === "action") {
            throw new Error(
              "Inline execution is only supported for queries and mutations.",
            );
          }
          try {
            const result =
              target.functionType === "query"
                ? // cast until transactionLimits is shipped / peer dep
                  await (this.ctx.runQuery as any)(
                    target.function as FunctionReference<
                      typeof target.functionType
                    >,
                    target.args,
                    { transactionLimits: message.transactionLimits },
                  )
                : // cast until transactionLimits is shipped / peer dep
                  await (this.ctx.runMutation as any)(
                    target.function as FunctionReference<
                      typeof target.functionType
                    >,
                    target.args,
                    { transactionLimits: message.transactionLimits },
                  );
            runResult = { kind: "success", returnValue: result ?? null };
          } catch (error: unknown) {
            runResult = { kind: "failed", error: formatErrorWithStack(error) };
          }
        }

        const commonFields = {
          inProgress: !runResult,
          name: message.name,
          args,
          argsSize: getConvexSize(args as Value),
          runResult,
          startedAt: this.now,
          completedAt: runResult ? this.now : undefined,
          version: this.definedVersion,
        } satisfies Omit<Step, "kind">;
        let step: IdsToStrings<Step>;
        switch (target.kind) {
          case "function":
            step = {
              kind: "function" as const,
              functionType: target.functionType,
              handle: await createFunctionHandle(target.function),
              ...commonFields,
            };
            break;
          case "workflow":
            step = {
              kind: "workflow" as const,
              handle: await createFunctionHandle(target.function),
              ...commonFields,
            };
            break;
          case "event":
            step = {
              kind: "event" as const,
              eventId: target.args.eventId,
              ...commonFields,
              args: target.args,
            };
            break;
          case "sleep":
            step = {
              kind: "sleep" as const,
              ...commonFields,
            };
            break;
          default:
            throw new Error(`Unknown step kind: ${(target as any).kind}`);
        }
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
      this.journalSize += getConvexSize(entry);
      if (this.journalSize > MAX_JOURNAL_SIZE) {
        throw new Error(
          journalSizeError(this.journalSize, this.workflowId) +
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
