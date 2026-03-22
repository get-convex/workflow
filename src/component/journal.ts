import { getConvexSize, v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server.js";
import {
  journalDocument,
  type JournalEntry,
  step,
  workflowDocument,
} from "./schema.js";
import { getWorkflow } from "./model.js";
import { logLevel } from "./logging.js";
import { vRetryBehavior, type WorkId } from "@convex-dev/workpool";
import {
  getWorkpool,
  type OnCompleteContext,
  workpoolOptions,
} from "./pool.js";
import { internal } from "./_generated/api.js";
import { createFunctionHandle, type FunctionHandle } from "convex/server";
import { getDefaultLogger } from "./utils.js";
import { assert } from "convex-helpers";
import { MAX_JOURNAL_SIZE } from "../shared.js";
import { awaitEvent } from "./event.js";
import { createHandler } from "./workflow.js";
import type { Doc, Id } from "./_generated/dataModel.js";

type EventNameOrId =
  | {
      id: Id<"events">;
      name?: string;
    }
  | {
      id?: Id<"events">;
      name: string;
    };

type SentEvent = Doc<"events"> & {
  state: { kind: "sent" };
};

async function sentEvents(
  ctx: MutationCtx,
  workflowId: Doc<"workflows">["_id"],
  events: Array<EventNameOrId>,
) {
  return (
    (await ctx.db
      .query("events")
      .withIndex("workflowId_state", (q) =>
        q.eq("workflowId", workflowId).eq("state.kind", "sent"),
      )
      .filter((q) =>
        q.or(
          ...events.map((e) =>
            e.id ? q.eq(q.field("_id"), e.id) : q.eq(q.field("name"), e.name),
          ),
        ),
      )
      .collect()) as SentEvent[]
  ).sort((a, b) => a.state.sentAt - b.state.sentAt);
}

export const load = query({
  args: {
    workflowId: v.id("workflows"),
    shortCircuit: v.optional(v.boolean()),
  },
  returns: v.object({
    workflow: workflowDocument,
    journalEntries: v.array(journalDocument),
    ok: v.boolean(),
    logLevel,
    blocked: v.optional(v.boolean()),
  }),
  handler: async (ctx, { workflowId, shortCircuit }) => {
    const workflow = await ctx.db.get("workflows", workflowId);
    assert(workflow, `Workflow not found: ${workflowId}`);
    const { logLevel } = await getDefaultLogger(ctx);
    const journalEntries: JournalEntry[] = [];
    let journalSize = 0;
    if (shortCircuit) {
      const inProgress = await ctx.db
        .query("steps")
        .withIndex("inProgress", (q) =>
          q.eq("step.inProgress", true).eq("workflowId", workflowId),
        )
        .first();
      if (inProgress) {
        return {
          journalEntries: [inProgress],
          blocked: true,
          workflow,
          logLevel,
          ok: true,
        };
      }
    }
    for await (const entry of ctx.db
      .query("steps")
      .withIndex("workflow", (q) => q.eq("workflowId", workflowId))) {
      journalEntries.push(entry);
      journalSize += getConvexSize(entry);
      if (journalSize > MAX_JOURNAL_SIZE) {
        return { journalEntries, workflow, logLevel, ok: false };
      }
    }
    return { journalEntries, workflow, logLevel, ok: true };
  },
});

export const startSteps = mutation({
  args: {
    workflowId: v.id("workflows"),
    generationNumber: v.number(),
    steps: v.array(
      v.object({
        step,
        retry: v.optional(v.union(v.boolean(), vRetryBehavior)),
        schedulerOptions: v.optional(
          v.union(
            v.object({ runAt: v.optional(v.number()) }),
            v.object({ runAfter: v.optional(v.number()) }),
          ),
        ),
      }),
    ),
    workpoolOptions: v.optional(workpoolOptions),
  },
  returns: v.array(journalDocument),
  handler: async (ctx, args): Promise<JournalEntry[]> => {
    const { generationNumber } = args;
    const workflow = await getWorkflow(ctx, args.workflowId, generationNumber);
    const console = await getDefaultLogger(ctx);

    if (workflow.runResult !== undefined) {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }
    const maxEntry = await ctx.db
      .query("steps")
      .withIndex("workflow", (q) => q.eq("workflowId", workflow._id))
      .order("desc")
      .first();
    const stepNumberBase = maxEntry ? maxEntry.stepNumber + 1 : 0;
    const workpool = await getWorkpool(ctx, args.workpoolOptions);
    const onComplete = internal.pool.onComplete;

    const entries = await Promise.all(
      args.steps.map(async (stepArgs, index) => {
        const { retry, schedulerOptions } = stepArgs;
        const stepNumber = stepNumberBase + index;
        const stepId = await ctx.db.insert("steps", {
          workflowId: workflow._id,
          stepNumber,
          step: stepArgs.step,
        });
        let entry = await ctx.db.get("steps", stepId);
        assert(entry, "Step not found");
        const step = entry.step;
        const { name } = step;
        console.event("started", {
          workflowId: workflow._id,
          workflowName: workflow.name,
          stepName: name,
          stepNumber,
        });
        if (step.kind === "event") {
          // Note: This modifies entry in place as well.
          entry = await awaitEvent(ctx, entry, {
            name,
            eventId: step.args.eventId,
          });
          if (step.runResult) {
            console.event("eventConsumed", {
              workflowId: entry.workflowId,
              workflowName: workflow.name,
              status: step.runResult.kind,
              eventName: step.name,
              stepNumber: stepNumber,
              durationMs: step.completedAt! - step.startedAt,
            });
          }
        } else if (step.kind === "workflow") {
          const workflowId = await createHandler(ctx, {
            workflowName: step.name,
            workflowHandle: step.handle,
            workflowArgs: step.args,
            maxParallelism: args.workpoolOptions?.maxParallelism,
            onComplete: {
              fnHandle: await createFunctionHandle(
                internal.pool.nestedWorkflowOnComplete,
              ),
              context: {
                stepId,
                generationNumber,
                workpoolOptions: args.workpoolOptions,
              } satisfies OnCompleteContext,
            },
            startAsync: true,
          });
          step.workflowId = workflowId;
        } else if (step.runResult) {
          // Already completed inline by the caller — nothing to enqueue.
          console.event("stepCompleted", {
            workflowId: entry.workflowId,
            workflowName: workflow.name,
            status: step.runResult.kind,
            stepName: step.name,
            stepNumber: stepNumber,
          });
        } else if (step.kind === "sleep") {
          const context: OnCompleteContext = {
            generationNumber,
            stepId,
            workpoolOptions: args.workpoolOptions,
          };
          step.workId = await workpool.enqueueQuery(
            ctx,
            internal.workflow.sleep,
            {},
            { context, onComplete, name, ...schedulerOptions },
          );
        } else if (step.kind === "race") {
          const raceId = entry._id;
          const events = step.args.events as EventNameOrId[];
          const now = Date.now();

          const idSet = new Set<string>();
          const idEvents = new Map<string, Doc<"events">>();
          for (const spec of events) {
            if (!spec.id) continue;
            idSet.add(spec.id);
            const existing = await ctx.db.get("events", spec.id);
            assert(
              existing,
              `Event not found: ${spec.id} in workflow ${workflow._id}`,
            );
            assert(
              existing.workflowId === workflow._id,
              `Event ${spec.id} (${existing.name}) does not belong to workflow ${workflow._id}`,
            );
            if (existing.state.kind === "waiting") {
              throw new Error(
                `Event already waiting: ${spec.id} (${existing.name}) in workflow ${workflow._id}`,
              );
            }
            if (existing.state.kind === "consumed") {
              throw new Error(
                `Event already consumed: ${spec.id} (${existing.name}) in workflow ${workflow._id}`,
              );
            }
            idEvents.set(spec.id, existing);
          }

          const sent = await sentEvents(ctx, workflow._id, events);

          const keyOf = (s: SentEvent) => (idSet.has(s._id) ? s._id : s.name);
          const eventsToWait = new Set(events.map((e) => (e.id ?? e.name)!));
          let eventsToConsume: Doc<"events">[] = [];
          let winner: SentEvent | undefined;
          switch (step.failure) {
            case "discard": {
              const toConsume = new Map<string, SentEvent>();
              for (const s of sent) {
                const key = keyOf(s);
                if (toConsume.has(key)) {
                  continue;
                }
                toConsume.set(key, s);
                eventsToWait.delete(key);
                if (s.state.result.kind === "success") {
                  winner = s;
                  break;
                }
              }
              eventsToConsume = Array.from(toConsume.values());
              break;
            }
            case "retry": {
              const winnerIndex = sent.findIndex(
                (s) => s.state.result.kind === "success",
              );
              if (winnerIndex >= 0) {
                winner = sent[winnerIndex];
                eventsToConsume = sent.slice(0, winnerIndex + 1);
              } else {
                eventsToConsume = sent;
              }
              break;
            }
            case "fail":
            case undefined:
            default: {
              if (sent.length > 0) {
                winner = sent[0];
                eventsToWait.delete(keyOf(winner));
                eventsToConsume.push(winner);
              }
              break;
            }
          }

          if (eventsToWait.size === 0 || winner) {
            if (winner) {
              step.raceWinnerEventId = winner._id;
              step.runResult =
                winner.state.result.kind === "success"
                  ? {
                      kind: "success",
                      returnValue: {
                        eventName: winner.name,
                        eventId: winner._id,
                        value: winner.state.result.returnValue,
                      },
                    }
                  : {
                      kind: "failed",
                      error: winner.state.result.kind === "failed" ? winner.state.result.error : "Canceled",
                    };
              eventsToWait.clear();
            } else {
              step.runResult = {
                kind: "failed",
                error: "Exhausted all events",
              };
            }
            entry.step.inProgress = false;
            entry.step.completedAt = Date.now();
            console.event("stepCompleted", {
              workflowId: entry.workflowId,
              workflowName: workflow.name,
              status: entry.step.runResult!.kind,
              stepName: entry.step.name,
              stepNumber,
            });
          }

          if (step.timeout && entry.step.inProgress) {
            const workId = await workpool.enqueueMutation(
              ctx,
              internal.race.timeout,
              {
                stepId: raceId,
                workpoolOptions: args.workpoolOptions,
                generationNumber,
              },
              {
                runAfter: step.timeout.ms,
              },
            );
            step.timeout.workId = workId;
          }

          // NOTE: This is what makes the retry + by-id case work:
          // a pre-sent id-event that failed must not be consumed,
          // so it can be re-patched back to waiting,
          // you can't recreate an event with the same id,
          // unlike name-based retry which just inserts a fresh waiting doc.
          eventsToConsume = eventsToConsume.filter(
            (e) => !eventsToWait.has(e._id),
          );

          if (!entry.step.inProgress) {
            const idCreated = Array.from(idEvents.values()).filter(
              (e) => e.state.kind === "created",
            );
            eventsToConsume.push(...idCreated);
            eventsToWait.clear();
          }

          const [, waitingIds] = await Promise.all([
            Promise.all(
              eventsToConsume.map((e) =>
                ctx.db.patch("events", e._id, {
                  state: {
                    kind: "consumed",
                    stepId: raceId,
                    sentAt: e.state.kind === "sent" ? e.state.sentAt : now,
                    waitingAt:
                      e.state.kind === "waiting" ? e.state.waitingAt : now,
                    consumedAt: now,
                  },
                }),
              ),
            ),
            Promise.all(
              Array.from(eventsToWait.values()).map(async (key) => {
                if (idSet.has(key)) {
                  const id = key as Id<"events">;
                  await ctx.db.patch("events", id, {
                    state: {
                      kind: "waiting",
                      waitingAt: now,
                      stepId: raceId,
                    },
                  });
                  return { id, name: idEvents.get(key)!.name };
                }
                const id = await ctx.db.insert("events", {
                  workflowId: workflow._id,
                  name: key,
                  state: {
                    kind: "waiting",
                    waitingAt: now,
                    stepId: raceId,
                  },
                });
                return { id, name: key };
              }),
            ),
          ]);

          step.events = [
            ...eventsToConsume.map((e) => ({ id: e._id, name: e.name })),
            ...waitingIds,
          ];
        } else {
          const context: OnCompleteContext = {
            generationNumber,
            stepId,
            workpoolOptions: args.workpoolOptions,
          };
          let workId: WorkId;
          switch (step.functionType) {
            case "query": {
              workId = await workpool.enqueueQuery(
                ctx,
                step.handle as FunctionHandle<"query">,
                step.args,
                { context, onComplete, name, ...schedulerOptions },
              );
              break;
            }
            case "mutation": {
              workId = await workpool.enqueueMutation(
                ctx,
                step.handle as FunctionHandle<"mutation">,
                step.args,
                { context, onComplete, name, ...schedulerOptions },
              );
              break;
            }
            case "action": {
              workId = await workpool.enqueueAction(
                ctx,
                step.handle as FunctionHandle<"action">,
                step.args,
                { context, onComplete, name, retry, ...schedulerOptions },
              );
              break;
            }
          }
          step.workId = workId;
        }
        await ctx.db.replace("steps", entry._id, entry);

        return entry;
      }),
    );
    return entries;
  },
});
