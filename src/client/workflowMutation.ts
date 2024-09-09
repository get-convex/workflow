import { api } from "../component/_generated/api.js"
import { PropertyValidators, v, Validator } from "convex/values";
import { Result, UseApi } from "../types.js";
import { WorkflowDefinition } from "./index.js";
import { internalMutationGeneric, RegisteredMutation } from "convex/server";
import { BaseChannel } from "async-channel";
import { StepExecutor, StepRequest, WorkerResult } from "./step.js";
import { StepContext } from "./stepContext.js";

// This function is defined in the calling component but then gets passed by
// function handle to the workflow component for execution. This function runs
// one "poll" of the workflow, replaying its execution from the journal until
// it blocks next.
export function workflowMutation<
  ArgsValidator extends PropertyValidators,
  ReturnsValidator extends Validator<any, any, any>,
>(
  component: UseApi<typeof api>,
  registered: WorkflowDefinition<ArgsValidator, ReturnsValidator>,
): RegisteredMutation<"internal", never, never> {
  return internalMutationGeneric({
    args: {
      workflowId: v.string(),
      generationNumber: v.number(),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
      // poll => done | notReady
      // workflow
      // workflowJournal
      // let journal represent all things that we can block on
      // - timers
      // - function calls
      // - external events? insert before current executing journal entry?
      // verify workflow state
      // load journal
      // block on function call
      // -> schedule action that runs function, writes result / schedules poll
      //      
      const workflow = await ctx.runQuery(component.index.loadWorkflow, {
        workflowId: args.workflowId,
      });
      if (workflow.generationNumber !== args.generationNumber) {
        console.error(`Invalid generation number: ${args.generationNumber}`);
        return;
      }
      if (workflow.state.type === "completed") {
        console.log(`Workflow ${args.workflowId} completed, returning.`);
        return;
      }
      const blockedBy = await ctx.runQuery(component.index.workflowBlockedBy, {
        workflowId: args.workflowId,
      });
      if (blockedBy !== null) {
        console.log(`Workflow ${args.workflowId} blocked by...`);
        console.log(`  ${blockedBy._id}: ${blockedBy.step.type}`);
        // TODO: reschedule ourselves if needed
        return;
      }
      const journalEntries = await ctx.runQuery(component.index.loadJournal, {
        workflowId: args.workflowId,
      });
      for (const journalEntry of journalEntries) {
        if (journalEntry.step.inProgress) {
          throw new Error(
            `Assertion failed: not blocked but have in-progress journal entry`,
          );
        }
      }
      const channel = new BaseChannel<StepRequest>(0);
      const executor = new StepExecutor(
        args.workflowId,
        ctx,
        component,
        journalEntries,
        channel,
      );

      const handlerWorker = async (): Promise<WorkerResult> => {
        const step = new StepContext(channel);
        let outcome: Result<any>;
        try {
          const result = await registered.handler(step, workflow.args);
          outcome = { type: "success", result: result ?? null };
        } catch (error: any) {
          outcome = { type: "error", error: error.message };
        }
        return { type: "handlerDone", outcome };
      };
      const executorWorker = async (): Promise<WorkerResult> => {
        return await executor.run();
      };
      const result = await Promise.race([handlerWorker(), executorWorker()]);
      switch (result.type) {
        case "handlerDone": {
          await ctx.runMutation(component.index.completeWorkflow, {
            workflowId: args.workflowId,
            generationNumber: args.generationNumber,
            outcome: result.outcome,
            now: Date.now(),
          });
          break;
        }
        case "executorBlocked": {
          const { _id, step } = result.entry;
          switch (step.type) {
            case "function": {
              await ctx.scheduler.runAfter(0, component.index.runFunction, {
                workflowId: args.workflowId,
                generationNumber: args.generationNumber,
                journalId: _id,
                functionType: step.functionType,
                handle: step.handle,
                args: step.args,
              });
              break;
            }
            case "sleep": {
              await ctx.scheduler.runAfter(
                step.durationMs,
                component.index.completeSleep,
                {
                  workflowId: args.workflowId,
                  generationNumber: args.generationNumber,
                  journalId: _id,
                },
              );
              break;
            }
          }
        }
      }
    },
  }) as any;
}