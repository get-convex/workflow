/// <reference types="vite/client" />

import type { WorkflowMutationResult } from "@convex-dev/workflow";
import { createFunctionHandle, type FunctionReference } from "convex/server";
import type { Value } from "convex/values";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { components, internal } from "../_generated/api.js";
import { initConvexTest } from "../setup.test.js";

const BASE_SEED = readInteger(
  "WORKFLOW_INTERLEAVING_SEED",
  0x1a7e_4ea5,
  0,
  0xffff_ffff,
);
const CASE_COUNT = readInteger("WORKFLOW_INTERLEAVING_CASES", 27, 22, 100);

type TestBackend = ReturnType<typeof initConvexTest>;
type LoadedState = Awaited<ReturnType<typeof loadActionState>>;
type ActionState = Pick<
  LoadedState,
  "workflow" | "journalEntries" | "logLevel"
>;
type ManualPollArgs = {
  workflowId: string;
  generationNumber: number;
  actionState: ActionState;
};
type WorkflowReference = FunctionReference<
  "mutation",
  "internal",
  ManualPollArgs,
  WorkflowMutationResult
>;
type ClaimedEntry = LoadedState["journalEntries"][number] & {
  generationNumber?: number;
};
type WorkflowWithDriver = LoadedState["workflow"] & {
  driverWorkId?: string;
};

type ScenarioKind =
  | "parallelDuplicatePoll"
  | "sequentialDuplicatePoll"
  | "abandonedClaim"
  | "cancelStalePoll"
  | "cancelInFlightPoll"
  | "cancelFreshPoll"
  | "restartStalePoll"
  | "restartInFlightPoll"
  | "restartFreshPoll"
  | "parallelInlinePoll"
  | "parallelInlineQueryPoll"
  | "inlineTransactionLimitPoll"
  | "mixedInlineActionPoll"
  | "inlineThenSleepPoll"
  | "sleepPoll"
  | "scheduledQueryPoll"
  | "scheduledMutationPoll"
  | "scheduledActionPoll"
  | "awaitEventPoll"
  | "nestedWorkflowPoll"
  | "oversizedArgumentPoll"
  | "oversizedInlineReturnPoll";

type Scenario = {
  seed: number;
  kind: ScenarioKind;
  repetitions: number;
};

type Score = "pass" | "partial" | "gap";

type Evaluation = {
  score: Score;
  evidence: string;
};

const measurements: Array<Scenario & Evaluation> = [];

class MutationDriverHarness {
  private constructor(
    readonly t: TestBackend,
    readonly workflowId: string,
    readonly workflow: WorkflowReference,
  ) {}

  static async create(
    workflow: WorkflowReference,
    args: Record<string, Value>,
  ): Promise<MutationDriverHarness> {
    const t = initConvexTest();
    const workflowId = await t.run(async (ctx) =>
      ctx.runMutation(components.workflow.workflow.create, {
        workflowName: "test/driverInterleavings:manual",
        workflowHandle: await createFunctionHandle(workflow),
        workflowArgs: args,
        createOnly: true,
        execution: { type: "action", maxDurationMs: 60_000 },
      }),
    );
    return new MutationDriverHarness(t, workflowId, workflow);
  }

  async snapshot(): Promise<ActionState> {
    const loaded = await loadActionState(this.t, this.workflowId);
    return {
      workflow: loaded.workflow,
      journalEntries: loaded.journalEntries,
      logLevel: loaded.logLevel,
    };
  }

  async poll(
    actionState: ActionState,
    generationNumber = actionState.workflow.generationNumber,
  ): Promise<Exclude<WorkflowMutationResult, string>> {
    const result = await this.t.mutation(this.workflow, {
      workflowId: this.workflowId,
      generationNumber,
      actionState,
    });
    expect(typeof result).not.toBe("string");
    return result as Exclude<WorkflowMutationResult, string>;
  }

  async pollSettled(actionState: ActionState) {
    try {
      return {
        kind: "fulfilled" as const,
        value: await this.poll(actionState),
      };
    } catch (error) {
      return {
        kind: "rejected" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async state(): Promise<LoadedState> {
    return await loadActionState(this.t, this.workflowId);
  }

  async cancel(): Promise<void> {
    await this.t.run((ctx) =>
      ctx.runMutation(components.workflow.workflow.cancel, {
        workflowId: this.workflowId,
      }),
    );
  }

  async failAndRestart(): Promise<void> {
    const state = await this.state();
    await this.t.run((ctx) =>
      ctx.runMutation(components.workflow.workflow.complete, {
        workflowId: this.workflowId,
        generationNumber: state.workflow.generationNumber,
        runResult: { kind: "failed", error: "injected driver failure" },
      }),
    );
    await this.t.run((ctx) =>
      ctx.runMutation(components.workflow.workflow.restart, {
        workflowId: this.workflowId,
        startAsync: true,
      }),
    );
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

afterAll(() => {
  if (process.env.WORKFLOW_INTERLEAVING_REPORT !== "1") return;
  const totals = measurements.reduce(
    (counts, result) => ({
      ...counts,
      [result.score]: counts[result.score] + 1,
    }),
    { pass: 0, partial: 0, gap: 0 },
  );
  process.stdout.write(
    `WORKFLOW_INTERLEAVING_SCORECARD ${JSON.stringify({
      baseSeed: BASE_SEED,
      cases: measurements.length,
      totals,
      measurements,
    })}\n`,
  );
});

const scenarios = generateScenarios(BASE_SEED, CASE_COUNT);

describe.each(scenarios)(
  "workflow mutation interleaving seed=$seed kind=$kind",
  (scenario) => {
    test(`matches the current ${expectedScore(scenario.kind)} baseline`, async () => {
      const evaluation = await evaluateScenario(scenario);
      measurements.push({ ...scenario, ...evaluation });
      expect(evaluation.score).toBe(expectedScore(scenario.kind));
    });
  },
);

async function evaluateScenario(scenario: Scenario): Promise<Evaluation> {
  switch (scenario.kind) {
    case "parallelDuplicatePoll":
      return await evaluateDuplicatePoll(scenario.repetitions, true);
    case "sequentialDuplicatePoll":
      return await evaluateDuplicatePoll(scenario.repetitions, false);
    case "abandonedClaim":
      return await evaluateAbandonedClaim(scenario.repetitions);
    case "cancelStalePoll":
      return await evaluateTerminalStalePoll("cancel");
    case "cancelInFlightPoll":
      return await evaluateInFlightPoll("cancel");
    case "restartStalePoll":
      return await evaluateTerminalStalePoll("restart");
    case "restartInFlightPoll":
      return await evaluateInFlightPoll("restart");
    case "cancelFreshPoll":
      return await evaluateFreshPoll("cancel");
    case "restartFreshPoll":
      return await evaluateFreshPoll("restart");
    case "parallelInlinePoll":
      return await evaluateParallelInlinePoll(scenario.repetitions);
    case "parallelInlineQueryPoll":
      return await evaluateParallelInlineQueryPoll(scenario.repetitions);
    case "inlineTransactionLimitPoll":
      return await evaluateInlineTransactionLimitPoll(scenario.repetitions);
    case "mixedInlineActionPoll":
      return await evaluateMixedInlineActionPoll(scenario.repetitions);
    case "inlineThenSleepPoll":
      return await evaluateInlineThenSleepPoll(scenario.repetitions);
    case "sleepPoll":
      return await evaluateSleepPoll(scenario.repetitions);
    case "scheduledQueryPoll":
      return await evaluateScheduledPoll("query", scenario.repetitions);
    case "scheduledMutationPoll":
      return await evaluateScheduledPoll("mutation", scenario.repetitions);
    case "scheduledActionPoll":
      return await evaluateScheduledPoll("action", scenario.repetitions);
    case "awaitEventPoll":
      return await evaluateEventPoll(scenario.repetitions);
    case "nestedWorkflowPoll":
      return await evaluateNestedWorkflowPoll(scenario.repetitions);
    case "oversizedArgumentPoll":
      return await evaluateOversizedPoll(
        internal.test.oversized.largeArgumentWorkflow,
        "Step arguments too large",
        0,
        scenario.repetitions,
      );
    case "oversizedInlineReturnPoll":
      return await evaluateOversizedPoll(
        internal.test.oversized.largeInlineReturnWorkflow,
        "Step return value too large",
        1,
        scenario.repetitions,
      );
  }
}

async function evaluateDuplicatePoll(
  repetitions: number,
  parallel: boolean,
): Promise<Evaluation> {
  const harness = await MutationDriverHarness.create(
    manualReference(internal.test.inline.actionDrivenSequence),
    { key: `duplicate-${parallel ? "parallel" : "sequential"}` },
  );
  const staleSnapshot = await harness.snapshot();
  const calls = Array.from(
    { length: repetitions },
    () => () => harness.pollSettled(staleSnapshot),
  );
  const results = parallel
    ? await Promise.all(calls.map((call) => call()))
    : await runSequentially(calls);
  const state = await harness.state();
  assertJournalShape(state);
  const claims = state.journalEntries.length;
  const rejected = results.filter(
    (result) => result.kind === "rejected",
  ).length;
  return {
    score: claims === 1 && rejected === 0 ? "pass" : "gap",
    evidence: `${repetitions} same-generation polls produced ${claims} logical claims and ${rejected} errors`,
  };
}

async function evaluateAbandonedClaim(
  repetitions: number,
): Promise<Evaluation> {
  const harness = await MutationDriverHarness.create(
    manualReference(internal.test.inline.actionDrivenSequence),
    { key: "abandoned" },
  );
  const first = await harness.poll(await harness.snapshot());
  expect(first.kind).toBe("steps");
  const results = [];
  for (let index = 0; index < repetitions; index++) {
    results.push(await harness.pollSettled(await harness.snapshot()));
  }
  const state = await harness.state();
  assertJournalShape(state);
  const allBlocked = results.every(
    (result) => result.kind === "fulfilled" && result.value.kind === "blocked",
  );
  const oneOrphan =
    state.journalEntries.length === 1 &&
    state.journalEntries[0].step.inProgress;
  return {
    score: allBlocked && oneOrphan ? "partial" : "gap",
    evidence:
      allBlocked && oneOrphan
        ? "re-polls are safe but remain blocked until driver onComplete performs recovery"
        : "re-poll changed the orphaned claim or failed unexpectedly",
  };
}

async function evaluateTerminalStalePoll(
  update: "cancel" | "restart",
): Promise<Evaluation> {
  const harness = await MutationDriverHarness.create(
    manualReference(internal.test.inline.actionDrivenSequence),
    { key: `${update}-stale` },
  );
  const staleSnapshot = await harness.snapshot();
  if (update === "cancel") {
    await harness.cancel();
  } else {
    await harness.failAndRestart();
  }
  const before = await harness.state();
  const result = await harness.pollSettled(staleSnapshot);
  const after = await harness.state();
  assertJournalShape(after);
  const unchanged = durableState(after) === durableState(before);
  if (!unchanged) {
    return {
      score: "gap",
      evidence: `stale ${update} poll mutated durable workflow state`,
    };
  }
  return result.kind === "fulfilled"
    ? { score: "pass", evidence: `stale ${update} poll exited cleanly` }
    : {
        score: "partial",
        evidence: `durable state was fenced, but the stale poll threw: ${result.error}`,
      };
}

async function evaluateInFlightPoll(
  update: "cancel" | "restart",
): Promise<Evaluation> {
  const harness = await MutationDriverHarness.create(
    manualReference(internal.test.inline.actionDrivenRetry),
    { key: `${update}-in-flight` },
  );
  const cachedState = await harness.snapshot();
  const first = await harness.poll(cachedState);
  expect(first.kind).toBe("steps");
  if (first.kind !== "steps") {
    return { score: "gap", evidence: "initial poll did not claim the action" };
  }
  // This is the action runner's local view while the direct action is running:
  // the claimed entry exists in memory and in the durable journal, but has no
  // result yet.
  cachedState.journalEntries.push(...first.entries);
  if (update === "cancel") {
    await harness.cancel();
  } else {
    await harness.failAndRestart();
  }
  const before = await harness.state();
  const result = await harness.pollSettled(cachedState);
  const after = await harness.state();
  assertJournalShape(after);
  if (durableState(after) !== durableState(before)) {
    return {
      score: "gap",
      evidence: `in-flight ${update} poll mutated durable workflow state`,
    };
  }
  const cleanExit =
    result.kind === "fulfilled" &&
    (result.value.kind === "blocked" ||
      (update === "cancel" &&
        result.value.kind === "complete" &&
        result.value.runResult.kind === "canceled"));
  return cleanExit
    ? {
        score: "pass",
        evidence: `cached in-progress claim made the old ${update} driver exit cleanly`,
      }
    : {
        score: "gap",
        evidence:
          result.kind === "rejected"
            ? result.error
            : `old driver returned ${result.value.kind}`,
      };
}

async function evaluateFreshPoll(
  update: "cancel" | "restart",
): Promise<Evaluation> {
  const harness = await MutationDriverHarness.create(
    manualReference(internal.test.inline.actionDrivenSequence),
    { key: `${update}-fresh` },
  );
  if (update === "cancel") {
    await harness.cancel();
  } else {
    await harness.failAndRestart();
  }
  const result = await harness.pollSettled(await harness.snapshot());
  const state = await harness.state();
  assertJournalShape(state);
  if (result.kind === "rejected") {
    return { score: "gap", evidence: result.error };
  }
  const expectedKind = update === "cancel" ? "complete" : "steps";
  return {
    score: result.value.kind === expectedKind ? "pass" : "gap",
    evidence: `fresh ${update} poll returned ${result.value.kind}`,
  };
}

async function evaluateParallelInlinePoll(
  repetitions: number,
): Promise<Evaluation> {
  const key = `inline-${repetitions}`;
  const harness = await MutationDriverHarness.create(
    manualReference(internal.test.inline.inlineMutations),
    { key },
  );
  const staleSnapshot = await harness.snapshot();
  const results = await Promise.all(
    Array.from({ length: repetitions }, () =>
      harness.pollSettled(staleSnapshot),
    ),
  );
  const value = await harness.t.query(internal.test.inline.getCounter, { key });
  const state = await harness.state();
  assertJournalShape(state);
  const rejected = results.filter(
    (result) => result.kind === "rejected",
  ).length;
  // One logical workflow execution contains exactly two increments. Convex's
  // transaction retry/rollback prevents duplicate committed side effects, but
  // duplicate callers currently surface terminal-state errors.
  if (value !== 2 || state.journalEntries.length !== 2) {
    return {
      score: "gap",
      evidence: `inline duplicate committed value=${value}, journalEntries=${state.journalEntries.length}`,
    };
  }
  return {
    score: rejected === 0 ? "pass" : "partial",
    evidence: `side effects committed once; ${rejected} duplicate poll(s) threw`,
  };
}

async function evaluateParallelInlineQueryPoll(
  repetitions: number,
): Promise<Evaluation> {
  const harness = await MutationDriverHarness.create(
    manualReference(internal.test.inline.sequentialInlineQueries),
    { key: `inline-query-${repetitions}` },
  );
  const results = await parallelPolls(harness, repetitions);
  const state = await harness.state();
  assertJournalShape(state);
  const rejected = rejectedCount(results);
  const allSettled = state.journalEntries.every(
    (entry) => !entry.step.inProgress && entry.step.runResult !== undefined,
  );
  const completed = state.workflow.runResult?.kind === "success";
  return {
    score:
      rejected === 0 &&
      state.journalEntries.length === 2 &&
      allSettled &&
      completed
        ? "pass"
        : "gap",
    evidence:
      `${repetitions} inline-query polls produced ${state.journalEntries.length} ` +
      `settled entries, ${rejected} errors, completed=${completed}`,
  };
}

async function evaluateInlineTransactionLimitPoll(
  repetitions: number,
): Promise<Evaluation> {
  const key = `inline-limit-${repetitions}`;
  const harness = await MutationDriverHarness.create(
    manualReference(internal.test.inline.catchTransactionLimit),
    { key },
  );
  const results = await parallelPolls(harness, repetitions);
  const state = await harness.state();
  assertJournalShape(state);
  const counter = await harness.t.query(internal.test.inline.getCounter, {
    key,
  });
  const [limited, fallback] = state.journalEntries;
  const validResults =
    state.journalEntries.length === 2 &&
    limited?.step.runResult?.kind === "failed" &&
    fallback?.step.runResult?.kind === "success" &&
    state.workflow.runResult?.kind === "success";
  const rejected = rejectedCount(results);
  return {
    score: validResults && counter === 1 && rejected === 0 ? "pass" : "gap",
    evidence:
      `limited inline write rolled back, fallback counter=${counter}, ` +
      `journalEntries=${state.journalEntries.length}, errors=${rejected}`,
  };
}

async function evaluateMixedInlineActionPoll(
  repetitions: number,
): Promise<Evaluation> {
  return await evaluateBlockingFeature(
    manualReference(internal.test.inline.mixedInlineAndAction),
    { key: `mixed-${repetitions}` },
    repetitions,
    (entries) => {
      if (entries.length !== 2)
        return `expected 2 entries, found ${entries.length}`;
      const [query, action] = entries;
      if (
        query.step.kind !== "function" ||
        query.step.functionType !== "query" ||
        query.step.inProgress
      ) {
        return "inline query was not durably settled";
      }
      if (
        action.step.kind !== "function" ||
        action.step.functionType !== "action" ||
        !action.step.inProgress
      ) {
        return "action was not the sole blocking claim";
      }
    },
  );
}

async function evaluateInlineThenSleepPoll(
  repetitions: number,
): Promise<Evaluation> {
  const key = `inline-sleep-${repetitions}`;
  const harness = await MutationDriverHarness.create(
    manualReference(internal.test.inline.actionDrivenInlineThenSleep),
    { key },
  );
  const results = await parallelPolls(harness, repetitions);
  const state = await harness.state();
  assertJournalShape(state);
  const counter = await harness.t.query(internal.test.inline.getCounter, {
    key,
  });
  const [inlineMutation, sleep] = state.journalEntries;
  const validShape =
    state.journalEntries.length === 2 &&
    inlineMutation?.step.kind === "function" &&
    inlineMutation.step.functionType === "mutation" &&
    !inlineMutation.step.inProgress &&
    sleep?.step.kind === "sleep" &&
    sleep.step.inProgress;
  const rejected = rejectedCount(results);
  return {
    score:
      validShape &&
      counter === 1 &&
      rejected === 0 &&
      stepsResultCount(results) === 1
        ? "pass"
        : "gap",
    evidence:
      `inline mutation committed ${counter} time(s), journalEntries=${state.journalEntries.length}, ` +
      `step results=${stepsResultCount(results)}, errors=${rejected}`,
  };
}

async function evaluateSleepPoll(repetitions: number): Promise<Evaluation> {
  return await evaluateBlockingFeature(
    manualReference(internal.test.inline.actionDrivenSleep),
    { label: `sleep-${repetitions}` },
    repetitions,
    (entries) => {
      if (entries.length !== 1)
        return `expected 1 entry, found ${entries.length}`;
      const [entry] = entries;
      if (entry.step.kind !== "sleep" || !entry.step.inProgress) {
        return "sleep was not represented as one blocking durable claim";
      }
    },
  );
}

async function evaluateScheduledPoll(
  functionType: "query" | "mutation" | "action",
  repetitions: number,
): Promise<Evaluation> {
  const runId = `scheduled-${functionType}-${repetitions}`;
  const evaluation = await evaluateBlockingFeature(
    manualReference(internal.test.randomized.runFaultPlan),
    {
      runId,
      operations: [
        {
          id: "scheduled",
          round: 0,
          kind: functionType,
          fault: "ok",
          failAttempts: 0,
          maxAttempts: 3,
          scheduled: true,
          handoff: false,
          value: "scheduled-value",
        },
      ],
    },
    repetitions,
    (entries) => {
      if (entries.length !== 1)
        return `expected 1 entry, found ${entries.length}`;
      const [entry] = entries;
      if (
        entry.step.kind !== "function" ||
        entry.step.functionType !== functionType ||
        !entry.step.inProgress
      ) {
        return `scheduled ${functionType} was not one blocking function claim`;
      }
      if (
        !entry.schedulerOptions ||
        !("runAfter" in entry.schedulerOptions) ||
        entry.schedulerOptions.runAfter !== 1
      ) {
        return `scheduled ${functionType} lost its runAfter option`;
      }
    },
  );
  return evaluation;
}

async function evaluateEventPoll(repetitions: number): Promise<Evaluation> {
  return await evaluateBlockingFeature(
    manualReference(internal.test.inline.actionDrivenEvent),
    {},
    repetitions,
    (entries) => {
      if (entries.length !== 1)
        return `expected 1 entry, found ${entries.length}`;
      const [entry] = entries;
      if (entry.step.kind !== "event" || !entry.step.inProgress) {
        return "event wait was not represented as one blocking claim";
      }
    },
  );
}

async function evaluateNestedWorkflowPoll(
  repetitions: number,
): Promise<Evaluation> {
  return await evaluateBlockingFeature(
    manualReference(internal.nestedWorkflow.parentWorkflow),
    { prompt: `nested-${repetitions}` },
    repetitions,
    (entries) => {
      if (entries.length !== 1)
        return `expected 1 entry, found ${entries.length}`;
      const [entry] = entries;
      if (entry.step.kind !== "workflow" || !entry.step.inProgress) {
        return "nested workflow was not represented as one blocking claim";
      }
    },
  );
}

async function evaluateOversizedPoll(
  workflow: FunctionReference<"mutation", "internal">,
  expectedError: string,
  expectedEntries: number,
  repetitions: number,
): Promise<Evaluation> {
  const harness = await MutationDriverHarness.create(
    manualReference(workflow),
    {},
  );
  const results = await parallelPolls(harness, repetitions);
  const state = await harness.state();
  assertJournalShape(state);
  const rejected = rejectedCount(results);
  const cleanFailures = results.every(
    (result) =>
      result.kind === "fulfilled" &&
      result.value.kind === "complete" &&
      result.value.runResult.kind === "failed" &&
      result.value.runResult.error.includes(expectedError),
  );
  const durableFailure =
    state.workflow.runResult?.kind === "failed" &&
    state.workflow.runResult.error.includes(expectedError);
  const entriesFailed = state.journalEntries.every(
    (entry) => entry.step.runResult?.kind === "failed",
  );
  return {
    score:
      cleanFailures &&
      durableFailure &&
      entriesFailed &&
      state.journalEntries.length === expectedEntries &&
      rejected === 0
        ? "pass"
        : "gap",
    evidence:
      `${repetitions} oversized polls failed cleanly with ${state.journalEntries.length} ` +
      `journal entries and ${rejected} errors`,
  };
}

async function evaluateBlockingFeature(
  workflow: WorkflowReference,
  args: Record<string, Value>,
  repetitions: number,
  inspect: (entries: LoadedState["journalEntries"]) => string | undefined,
): Promise<Evaluation> {
  const harness = await MutationDriverHarness.create(workflow, args);
  const results = await parallelPolls(harness, repetitions);
  const state = await harness.state();
  assertJournalShape(state);
  const rejected = rejectedCount(results);
  const problem = inspect(state.journalEntries);
  const stepResults = stepsResultCount(results);
  return {
    score: !problem && rejected === 0 && stepResults === 1 ? "pass" : "gap",
    evidence:
      problem ??
      `${repetitions} polls produced one blocking claim, ${stepResults} step result(s), and ${rejected} errors`,
  };
}

async function parallelPolls(
  harness: MutationDriverHarness,
  repetitions: number,
) {
  const snapshot = await harness.snapshot();
  return await Promise.all(
    Array.from({ length: repetitions }, () => harness.pollSettled(snapshot)),
  );
}

function rejectedCount(
  results: Awaited<ReturnType<MutationDriverHarness["pollSettled"]>>[],
): number {
  return results.filter((result) => result.kind === "rejected").length;
}

function stepsResultCount(
  results: Awaited<ReturnType<MutationDriverHarness["pollSettled"]>>[],
): number {
  return results.filter(
    (result) => result.kind === "fulfilled" && result.value.kind === "steps",
  ).length;
}

function assertJournalShape(state: LoadedState): void {
  const stepNumbers = state.journalEntries.map((entry) => entry.stepNumber);
  expect(new Set(stepNumbers).size).toBe(stepNumbers.length);
  for (let index = 1; index < stepNumbers.length; index++) {
    expect(stepNumbers[index]).toBeGreaterThan(stepNumbers[index - 1]);
  }
  for (const entry of state.journalEntries) {
    expect((entry as ClaimedEntry).generationNumber ?? 0).toBeLessThanOrEqual(
      state.workflow.generationNumber,
    );
  }
}

function durableState(state: LoadedState): string {
  return JSON.stringify({
    generationNumber: state.workflow.generationNumber,
    runResult: state.workflow.runResult,
    driverWorkId: (state.workflow as WorkflowWithDriver).driverWorkId,
    journalEntries: state.journalEntries,
  });
}

function expectedScore(kind: ScenarioKind): Score {
  return kind === "abandonedClaim" ? "partial" : "pass";
}

function generateScenarios(seed: number, count: number): Scenario[] {
  const random = mulberry32(seed);
  const required: ScenarioKind[] = [
    "parallelDuplicatePoll",
    "sequentialDuplicatePoll",
    "abandonedClaim",
    "cancelStalePoll",
    "cancelInFlightPoll",
    "cancelFreshPoll",
    "restartStalePoll",
    "restartInFlightPoll",
    "restartFreshPoll",
    "parallelInlinePoll",
    "parallelInlineQueryPoll",
    "inlineTransactionLimitPoll",
    "mixedInlineActionPoll",
    "inlineThenSleepPoll",
    "sleepPoll",
    "scheduledQueryPoll",
    "scheduledMutationPoll",
    "scheduledActionPoll",
    "awaitEventPoll",
    "nestedWorkflowPoll",
    "oversizedArgumentPoll",
    "oversizedInlineReturnPoll",
  ];
  const kinds = required;
  return Array.from({ length: count }, (_, index) => ({
    seed: mixSeed(seed, index),
    kind: required[index] ?? pick(random, kinds),
    repetitions: integer(random, 2, 4),
  }));
}

async function runSequentially<T>(
  calls: Array<() => Promise<T>>,
): Promise<T[]> {
  const results: T[] = [];
  for (const call of calls) results.push(await call());
  return results;
}

async function loadActionState(t: TestBackend, workflowId: string) {
  return await t.run((ctx) =>
    ctx.runQuery(components.workflow.journal.load, { workflowId }),
  );
}

function manualReference(
  reference: FunctionReference<"mutation", "internal">,
): WorkflowReference {
  // A registered workflow advertises only its public direct-call arguments in
  // generated types. The component invokes the same function handle with the
  // internal poll shape exercised by this harness.
  return reference as unknown as WorkflowReference;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function mixSeed(base: number, index: number): number {
  let value = (base + Math.imul(index + 1, 0x9e37_79b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x21f0_aaad);
  value ^= value >>> 15;
  value = Math.imul(value, 0x735a_2d97);
  return (value ^ (value >>> 15)) >>> 0;
}

function integer(
  random: () => number,
  min: number,
  maxInclusive: number,
): number {
  return Math.floor(random() * (maxInclusive - min + 1)) + min;
}

function pick<const T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)];
}

function readInteger(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
