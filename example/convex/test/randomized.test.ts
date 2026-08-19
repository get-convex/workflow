/// <reference types="vite/client" />

import { getStatus, listSteps, WorkflowManager } from "@convex-dev/workflow";
import { assert } from "convex-helpers";
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

const workflow = new WorkflowManager(components.workflow);
const BASE_SEED = readInteger(
  "WORKFLOW_HARNESS_SEED",
  0x5eedc0de,
  0,
  0xffffffff,
);
const CASE_COUNT = readInteger("WORKFLOW_HARNESS_CASES", 6, 1, 100);
const OPERATIONS_PER_CASE = readInteger(
  "WORKFLOW_HARNESS_OPERATIONS",
  12,
  6,
  64,
);

type Operation = {
  id: string;
  round: number;
  kind: "query" | "mutation" | "action" | "sleep";
  fault: "ok" | "error" | "timeout";
  failAttempts: number;
  maxAttempts: number;
  scheduled: boolean;
  handoff: boolean;
  value: string;
};

type Outcome = {
  operationId: string;
  kind: Operation["kind"];
  status: "success" | "failed";
  value: string;
};

type RunState = {
  commits: Array<{
    operationId: string;
    kind: "mutation" | "action";
    value: string;
  }>;
  actionAttempts: Array<{ operationId: string; attempts: number }>;
};

const measurements: Array<{
  seed: number;
  operations: number;
  mutationWallMs: number;
  actionWallMs: number;
  mutationVirtualMs: number;
  actionVirtualMs: number;
  journalEntries: number;
  injectedFailures: number;
  actionAttempts: number;
}> = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

afterAll(() => {
  if (process.env.WORKFLOW_HARNESS_REPORT !== "1") return;
  const totals = measurements.reduce(
    (sum, item) => ({
      operations: sum.operations + item.operations,
      mutationWallMs: sum.mutationWallMs + item.mutationWallMs,
      actionWallMs: sum.actionWallMs + item.actionWallMs,
      mutationVirtualMs: sum.mutationVirtualMs + item.mutationVirtualMs,
      actionVirtualMs: sum.actionVirtualMs + item.actionVirtualMs,
      journalEntries: sum.journalEntries + item.journalEntries,
      injectedFailures: sum.injectedFailures + item.injectedFailures,
      actionAttempts: sum.actionAttempts + item.actionAttempts,
    }),
    {
      operations: 0,
      mutationWallMs: 0,
      actionWallMs: 0,
      mutationVirtualMs: 0,
      actionVirtualMs: 0,
      journalEntries: 0,
      injectedFailures: 0,
      actionAttempts: 0,
    },
  );
  process.stdout.write(
    "WORKFLOW_HARNESS_METRICS " +
      JSON.stringify({
        baseSeed: BASE_SEED,
        cases: measurements.length,
        ...totals,
        mutationOperationsPerSecond: rate(
          totals.operations,
          totals.mutationWallMs,
        ),
        actionOperationsPerSecond: rate(totals.operations, totals.actionWallMs),
        measurements,
      }) +
      "\n",
  );
});

describe.each(
  Array.from({ length: CASE_COUNT }, (_, index) => mixSeed(BASE_SEED, index)),
)("deterministic workflow fault plan seed=%s", (seed) => {
  test("preserves continuation and state in mutation and action execution modes", async () => {
    const plan = generatePlan(seed, OPERATIONS_PER_CASE);
    const t = initConvexTest();

    try {
      const mutation = await execute(t, seed, "mutation", plan);
      const action = await execute(t, seed, "action", plan);
      const expected = expectedOutcomes(plan);
      const expectedState = expectedRunState(plan);

      expect(mutation.outcomes).toEqual(expected);
      expect(action.outcomes).toEqual(expected);
      expect(action.outcomes).toEqual(mutation.outcomes);
      expect(mutation.state).toEqual(expectedState);
      expect(action.state).toEqual(expectedState);
      expect(action.trace).toEqual(mutation.trace);

      measurements.push({
        seed,
        operations: plan.length,
        mutationWallMs: mutation.wallMs,
        actionWallMs: action.wallMs,
        mutationVirtualMs: mutation.virtualMs,
        actionVirtualMs: action.virtualMs,
        journalEntries: action.trace.length,
        injectedFailures: expected.filter((item) => item.status === "failed")
          .length,
        actionAttempts: action.state.actionAttempts.reduce(
          (sum, item) => sum + item.attempts,
          0,
        ),
      });
    } catch (error) {
        throw new Error(
          `Workflow harness failed. Reproduce with WORKFLOW_HARNESS_SEED=${seed} WORKFLOW_HARNESS_CASES=1 WORKFLOW_HARNESS_OPERATIONS=${OPERATIONS_PER_CASE}\nPlan: ${JSON.stringify(plan)}\n${String(error)}`,
        );
    }
  }, 30_000);
});

async function execute(
  t: ReturnType<typeof initConvexTest>,
  seed: number,
  mode: "mutation" | "action",
  operations: Operation[],
) {
  const runId = `${seed.toString(16)}-${mode}`;
  const virtualStartedAt = Date.now();
  const wallStartedAt = vi.getRealSystemTime();
  const workflowId = await t.run((ctx) =>
    workflow.start(
      ctx,
      internal.test.randomized.runFaultPlan,
      { runId, operations },
      { executionMode: mode },
    ),
  );
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const wallMs = vi.getRealSystemTime() - wallStartedAt;
  const virtualMs = Date.now() - virtualStartedAt;

  const status = await t.run((ctx) =>
    getStatus(ctx, components.workflow, workflowId),
  );
  assert(
    status.type === "completed",
    `Workflow ${workflowId} did not complete`,
  );
  const state = await t.query(internal.test.randomized.readRunState, { runId });
  const steps = await t.run((ctx) =>
    listSteps(ctx, components.workflow, workflowId, {
      paginationOpts: { cursor: null, numItems: 256 },
    }),
  );
  assert(steps.isDone, `Harness journal exceeded one page for ${workflowId}`);

  return {
    outcomes: status.result as Outcome[],
    state: normalizeState(state),
    trace: steps.page.map((item) => ({
      name: item.name,
      kind: item.kind,
      status: item.runResult?.kind,
      value:
        item.runResult?.kind === "success"
          ? item.runResult.returnValue
          : item.runResult?.kind === "failed"
            ? classifyError(item.runResult.error)
            : item.runResult?.kind,
    })),
    wallMs,
    virtualMs,
  };
}

function expectedOutcomes(operations: Operation[]): Outcome[] {
  return operations.map((item) => {
    const succeeds =
      item.kind === "sleep" ||
      item.fault === "ok" ||
      (item.kind === "action" && item.failAttempts < item.maxAttempts);
    return {
      operationId: item.id,
      kind: item.kind,
      status: succeeds ? "success" : "failed",
      value: succeeds ? item.value : item.fault,
    };
  });
}

function expectedRunState(operations: Operation[]): RunState {
  return normalizeState({
    commits: operations
      .filter(
        (item): item is Operation & { kind: "mutation" | "action" } =>
          (item.kind === "mutation" && item.fault === "ok") ||
          (item.kind === "action" &&
            (item.fault === "ok" || item.failAttempts < item.maxAttempts)),
      )
      .map(({ id, kind, value }) => ({ operationId: id, kind, value })),
    actionAttempts: operations
      .filter((item) => item.kind === "action")
      .map((item) => ({
        operationId: item.id,
        attempts:
          item.fault === "ok"
            ? 1
            : Math.min(item.failAttempts + 1, item.maxAttempts),
      })),
  });
}

function normalizeState(state: RunState): RunState {
  return {
    commits: [...state.commits].sort((a, b) =>
      a.operationId.localeCompare(b.operationId),
    ),
    actionAttempts: [...state.actionAttempts].sort((a, b) =>
      a.operationId.localeCompare(b.operationId),
    ),
  };
}

function classifyError(error: string): string {
  if (error.includes("INJECTED_SYSTEM_TIMEOUT")) return "timeout";
  if (error.includes("INJECTED_ERROR")) return "error";
  return `unexpected:${error}`;
}

function generatePlan(seed: number, count: number): Operation[] {
  const random = mulberry32(seed);
  const required: Array<Partial<Operation>> = [
    { kind: "query", fault: "timeout" },
    { kind: "mutation", fault: "error" },
    {
      kind: "action",
      fault: "timeout",
      failAttempts: 1,
      maxAttempts: 3,
    },
    {
      kind: "action",
      fault: "error",
      failAttempts: 3,
      maxAttempts: 3,
    },
    { kind: "mutation", fault: "ok" },
    { kind: "sleep", fault: "ok", scheduled: true },
  ];

  return Array.from({ length: count }, (_, index) => {
    const preset = required[index];
    const kind =
      preset?.kind ?? pick(random, ["query", "mutation", "action", "sleep"]);
    const fault =
      kind === "sleep"
        ? "ok"
        : (preset?.fault ?? pick(random, ["ok", "ok", "error", "timeout"]));
    const maxAttempts =
      preset?.maxAttempts ?? (kind === "action" ? integer(random, 1, 4) : 1);
    const failAttempts =
      preset?.failAttempts ??
      (kind === "action" && fault !== "ok"
        ? integer(random, 1, maxAttempts + 1)
        : 0);
    return {
      id: `op-${index.toString().padStart(3, "0")}`,
      round: Math.floor(index / 2),
      kind,
      fault,
      failAttempts,
      maxAttempts,
      scheduled: preset?.scheduled ?? random() < 0.2,
      handoff: kind === "action" && random() < 0.35,
      value: `value-${seed.toString(16)}-${index}`,
    };
  });
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
  let value = (base + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x21f0aaad);
  value ^= value >>> 15;
  value = Math.imul(value, 0x735a2d97);
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

function rate(operations: number, milliseconds: number): number {
  return milliseconds === 0
    ? 0
    : Math.round((operations * 100_000) / milliseconds) / 100;
}
