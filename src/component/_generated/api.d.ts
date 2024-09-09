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

import type * as index from "../index.js";

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
  index: typeof index;
}>;
declare const fullApiWithMounts: typeof fullApi & {
  index: {
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
              functionType: "query" | "mutation" | "action";
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
            };
        workflowHandle: string;
      }
    >;
    pushJournalEntry: FunctionReference<
      "mutation",
      "public",
      {
        step:
          | {
              args: any;
              completedAt?: number;
              functionType: "query" | "mutation" | "action";
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
              functionType: "query" | "mutation" | "action";
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
    runFunction: FunctionReference<
      "action",
      "public",
      {
        args: any;
        functionType: "query" | "mutation" | "action";
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
              functionType: "query" | "mutation" | "action";
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

export declare const api: FilterApi<
  typeof fullApiWithMounts,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApiWithMounts,
  FunctionReference<any, "internal">
>;

/* prettier-ignore-end */
