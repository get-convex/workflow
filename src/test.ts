/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import { componentsGeneric } from "convex/server";
import type { ComponentApi } from "./component/_generated/component.js";
import schema from "./component/schema.js";
import workpool from "@convex-dev/workpool/test";
const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the component with the test convex instance.
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 * @returns a component api to test via ctx.runMutation or for thick client
 *   usage. Also provides types for convex-test's defineTestApp.
 */
export function register<
  Schema extends SchemaDefinition<GenericSchema, boolean>,
>(t: TestConvex<Schema>, name: string = "workflow") {
  t.registerComponent(name, schema, modules);
  workpool.register(t, `${name}/workpool`);
  return componentsGeneric()[name] as unknown as ComponentApi;
}
export default { register, schema, modules };
