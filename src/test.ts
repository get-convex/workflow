/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "./component/schema.js";
import workpool from "@convex-dev/workpool/test";
const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the component with the test convex instance.
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function register<
  Schema extends SchemaDefinition<GenericSchema, boolean>,
>(t: TestConvex<Schema>, name: string = "workflow") {
  t.registerComponent(name, schema, modules);
  // TestConvex<Schema> is invariant w.r.t. Schema, so a constrained generic
  // parameter is not directly assignable to the concrete base type that
  // workpool.register expects. The cast is safe: the value satisfies the
  // interface at runtime.
  workpool.register(
    t as unknown as TestConvex<SchemaDefinition<GenericSchema, boolean>>,
    `${name}/workpool`,
  );
}
export default { register, schema, modules };
