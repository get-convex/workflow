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

import type * as fetch from "../fetch.js";
import type * as index from "../index.js";
import type * as model from "../model.js";

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
  fetch: typeof fetch;
  index: typeof index;
  model: typeof model;
}>;
export type Mounts = {
  fetch: {
    executeFetch: FunctionReference<
      "action",
      "public",
      { body?: ArrayBuffer; headers: any; method: string; url: string },
      { body: ArrayBuffer; headers: any; status: number; statusText: string }
    >;
  };
  index: {
    cancelWorkflow: FunctionReference<
      "mutation",
      "public",
      { workflowId: string },
      null
    >;
    completeSleep: FunctionReference<
      "mutation",
      "public",
      { generationNumber: number; journalId: string; workflowId: string },
      null
    >;
    completeWorkflow: FunctionReference<
      "mutation",
      "public",
      {
        generationNumber: number;
        now: number;
        outcome:
          | { result: any; type: "success" }
          | { error: string; type: "error" };
        workflowId: string;
      },
      null
    >;
    createWorkflow: FunctionReference<
      "mutation",
      "public",
      { workflowArgs: any; workflowHandle: string },
      string
    >;
    loadJournal: FunctionReference<
      "query",
      "public",
      { workflowId: string },
      Array<{
        _creationTime: number;
        _id: string;
        step:
          | {
              args: any;
              completedAt?: number;
              functionType:
                | { type: "query" }
                | { type: "mutation" }
                | { recoveryId?: string; type: "action" };
              handle: string;
              inProgress: boolean;
              outcome?:
                | { result: any; type: "success" }
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
    loadWorkflow: FunctionReference<
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
                | { result: any; type: "success" }
                | { error: string; type: "error" };
              type: "completed";
            }
          | { canceledAt: number; type: "canceled" };
        workflowHandle: string;
      }
    >;
    pushJournalEntry: FunctionReference<
      "mutation",
      "public",
      {
        generationNumber: number;
        step:
          | {
              args: any;
              completedAt?: number;
              functionType:
                | { type: "query" }
                | { type: "mutation" }
                | { recoveryId?: string; type: "action" };
              handle: string;
              inProgress: boolean;
              outcome?:
                | { result: any; type: "success" }
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
              completedAt?: number;
              functionType:
                | { type: "query" }
                | { type: "mutation" }
                | { recoveryId?: string; type: "action" };
              handle: string;
              inProgress: boolean;
              outcome?:
                | { result: any; type: "success" }
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
    startFunction: FunctionReference<
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
    workflowBlockedBy: FunctionReference<
      "query",
      "public",
      { workflowId: string },
      {
        _creationTime: number;
        _id: string;
        step:
          | {
              args: any;
              completedAt?: number;
              functionType:
                | { type: "query" }
                | { type: "mutation" }
                | { recoveryId?: string; type: "action" };
              handle: string;
              inProgress: boolean;
              outcome?:
                | { result: any; type: "success" }
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
