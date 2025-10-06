/// <reference types="vite/client" />
import { test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import workflow from "@convex-dev/workflow/test";

export const modules = import.meta.glob("./**/*.*s");

export function initConvexTest() {
  const t = convexTest(schema, modules);
  t.registerComponent("workflow", workflow.schema, workflow.modules);
  return t;
}

test("setup", () => {});
