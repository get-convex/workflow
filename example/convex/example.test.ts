/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, test, vi } from "vitest";
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
