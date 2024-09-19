/* prettier-ignore-start */

/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as functions from "../functions.js";
import type * as journal from "../journal.js";
import type * as model from "../model.js";
import type * as sleep from "../sleep.js";
import type * as workflow from "../workflow.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  functions: typeof functions;
  journal: typeof journal;
  model: typeof model;
  sleep: typeof sleep;
  workflow: typeof workflow;
}>;
export type Mounts = {
  functions: {
    start: FunctionReference<
      "mutation",
      "public",
      {
        args: any;
        functionType:
          | { type: "query" }
          | { type: "mutation" }
          | { type: "action" };
        generationNumber: number;
        handle: string;
        journalId: string;
        workflowId: string;
      },
      null
    >;
  };
  journal: {
    load: FunctionReference<
      "query",
      "public",
      { workflowId: string },
      Array<{
        _creationTime: number;
        _id: string;
        step:
          | {
              args: any;
              argsSize: number;
              completedAt?: number;
              functionType:
                | { type: "query" }
                | { type: "mutation" }
                | { recoveryId?: string; type: "action" };
              handle: string;
              inProgress: boolean;
              outcome?:
                | { result: any; resultSize: number; type: "success" }
                | { error: string; type: "error" };
              startedAt: number;
              type: "function";
            }
          | {
              deadline: number;
              durationMs: number;
              inProgress: boolean;
              type: "sleep";
            };
        stepNumber: number;
        workflowId: string;
      }>
    >;
    pushEntry: FunctionReference<
      "mutation",
      "public",
      {
        generationNumber: number;
        step:
          | {
              args: any;
              argsSize: number;
              completedAt?: number;
              functionType:
                | { type: "query" }
                | { type: "mutation" }
                | { recoveryId?: string; type: "action" };
              handle: string;
              inProgress: boolean;
              outcome?:
                | { result: any; resultSize: number; type: "success" }
                | { error: string; type: "error" };
              startedAt: number;
              type: "function";
            }
          | {
              deadline: number;
              durationMs: number;
              inProgress: boolean;
              type: "sleep";
            };
        stepNumber: number;
        workflowId: string;
      },
      {
        _creationTime: number;
        _id: string;
        step:
          | {
              args: any;
              argsSize: number;
              completedAt?: number;
              functionType:
                | { type: "query" }
                | { type: "mutation" }
                | { recoveryId?: string; type: "action" };
              handle: string;
              inProgress: boolean;
              outcome?:
                | { result: any; resultSize: number; type: "success" }
                | { error: string; type: "error" };
              startedAt: number;
              type: "function";
            }
          | {
              deadline: number;
              durationMs: number;
              inProgress: boolean;
              type: "sleep";
            };
        stepNumber: number;
        workflowId: string;
      }
    >;
  };
  sleep: {
    start: FunctionReference<
      "mutation",
      "public",
      {
        durationMs: number;
        generationNumber: number;
        journalId: string;
        workflowId: string;
      },
      null
    >;
  };
  workflow: {
    blockedBy: FunctionReference<
      "query",
      "public",
      { workflowId: string },
      {
        _creationTime: number;
        _id: string;
        step:
          | {
              args: any;
              argsSize: number;
              completedAt?: number;
              functionType:
                | { type: "query" }
                | { type: "mutation" }
                | { recoveryId?: string; type: "action" };
              handle: string;
              inProgress: boolean;
              outcome?:
                | { result: any; resultSize: number; type: "success" }
                | { error: string; type: "error" };
              startedAt: number;
              type: "function";
            }
          | {
              deadline: number;
              durationMs: number;
              inProgress: boolean;
              type: "sleep";
            };
        stepNumber: number;
        workflowId: string;
      } | null
    >;
    cancel: FunctionReference<
      "mutation",
      "public",
      { workflowId: string },
      null
    >;
    cleanup: FunctionReference<
      "mutation",
      "public",
      { workflowId: string },
      null
    >;
    complete: FunctionReference<
      "mutation",
      "public",
      {
        generationNumber: number;
        now: number;
        outcome:
          | { result: any; resultSize: number; type: "success" }
          | { error: string; type: "error" };
        workflowId: string;
      },
      null
    >;
    create: FunctionReference<
      "mutation",
      "public",
      { workflowArgs: any; workflowHandle: string },
      string
    >;
    load: FunctionReference<
      "query",
      "public",
      { workflowId: string },
      {
        _creationTime: number;
        _id: string;
        args: any;
        generationNumber: number;
        startedAt: number;
        state:
          | { type: "running" }
          | {
              completedAt: number;
              outcome:
                | { result: any; resultSize: number; type: "success" }
                | { error: string; type: "error" };
              type: "completed";
            }
          | { canceledAt: number; type: "canceled" };
        workflowHandle: string;
      }
    >;
  };
};
// For now fullApiWithMounts is only fullApi which provides
// jump-to-definition in component client code.
// Use Mounts for the same type without the inference.
declare const fullApiWithMounts: typeof fullApi;

export declare const api: FilterApi<
  typeof fullApiWithMounts,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApiWithMounts,
  FunctionReference<any, "internal">
>;

/* prettier-ignore-end */
