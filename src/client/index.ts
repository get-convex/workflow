import {
  createFunctionHandle,
  FunctionArgs,
  FunctionReference,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  getFunctionName,
  RegisteredMutation,
} from "convex/server";
import { ObjectType, PropertyValidators } from "convex/values";
import { api } from "../component/_generated/api.js";
import { OpaqueIds, UseApi, WorkflowId } from "../types.js";
import { workflowMutation } from "./workflowMutation.js";
import { LogLevel } from "../component/logging.js";
import { RetryBehavior } from "@convex-dev/workpool";
import { Step } from "../component/schema.js";

export type { WorkflowId };

type ActionCtxRunners = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction"
>;

export type WorkflowStep = ActionCtxRunners & {
  /**
   * Sleep for a given number of milliseconds. It's totally fine for this to be
   * very long (e.g. on the order of months).
   *
   * @param ms - The number of milliseconds to sleep.
   */
  sleep(ms: number): Promise<void>;
};

export type WorkflowDefinition<ArgsValidator extends PropertyValidators> = {
  args?: ArgsValidator;
  handler: (
    step: WorkflowStep,
    args: ObjectType<ArgsValidator>,
  ) => Promise<void>;
};

export type WorkflowStatus =
  | { type: "inProgress"; running: OpaqueIds<Step>[] }
  | { type: "completed" }
  | { type: "canceled" }
  | { type: "failed"; error: string };

export class WorkflowManager {
  constructor(
    private component: UseApi<typeof api>,
    private options?: {
      logLevel?: LogLevel;
      maxParallelism?: number;
      defaultRetryBehavior?: RetryBehavior;
      retryActionsByDefault?: boolean;
    },
  ) {
    if (process.env.WORKFLOW_LOG_LEVEL) {
      if (
        !["DEBUG", "INFO", "WARN", "ERROR"].includes(
          process.env.WORKFLOW_LOG_LEVEL,
        )
      ) {
        console.warn(
          `Invalid ENV log level (${process.env.WORKFLOW_LOG_LEVEL}), ignoring`,
        );
      } else {
        this.options = {
          ...this.options,
          logLevel: process.env.WORKFLOW_LOG_LEVEL as LogLevel,
        };
      }
    }
  }

  /**
   * Define a new workflow.
   *
   * @param workflow - The workflow definition.
   * @returns The workflow mutation.
   */
  define<ArgsValidator extends PropertyValidators>(
    workflow: WorkflowDefinition<ArgsValidator>,
  ): RegisteredMutation<"internal", ObjectType<ArgsValidator>, null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return workflowMutation(this.component, workflow) as any;
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
    args: FunctionArgs<F>,
  ): Promise<WorkflowId> {
    const handle = await createFunctionHandle(workflow);
    const workflowId = await ctx.runMutation(this.component.workflow.create, {
      workflowName: getFunctionName(workflow),
      workflowHandle: handle,
      workflowArgs: args,
      logLevel: this.options?.logLevel,
      maxParallelism: this.options?.maxParallelism,
      defaultRetryBehavior: this.options?.defaultRetryBehavior,
      retryActionsByDefault: this.options?.retryActionsByDefault,
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
    const running = inProgress.map((entry) => entry.step);
    switch (workflow.state.type) {
      case "running":
        return { type: "inProgress", running };
      case "canceled":
        return { type: "canceled" };
      case "completed":
        if (workflow.state.outcome.type === "success") {
          return { type: "completed" };
        } else {
          return { type: "failed", error: workflow.state.outcome.error };
        }
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
}

type RunQueryCtx = {
  runQuery: GenericQueryCtx<GenericDataModel>["runQuery"];
};
type RunMutationCtx = {
  runMutation: GenericMutationCtx<GenericDataModel>["runMutation"];
};
