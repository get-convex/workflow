/// <reference types="vite/client" />
import { test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import workflow from "@convex-dev/workflow/test";

export const modules = import.meta.glob("./**/*.*s");

export function initConvexTest() {
  const t = convexTest(schema, modules);
  workflow.register(t);
  return t;
}

test("setup", () => {});
