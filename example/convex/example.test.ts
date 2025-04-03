/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { initConvexTest } from "./setup.test";

describe("workpool", () => {
  async function setupTest() {
    const t = initConvexTest();
    return t;
  }

  let t: Awaited<ReturnType<typeof setupTest>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    console.log("beforeEach");
    t = await setupTest();
  });

  afterEach(async () => {
    console.log("afterEach");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
  });

  test("TODO", async () => {
    console.log("TODO");
  });
});
