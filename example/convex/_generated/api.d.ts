/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as example from "../example.js";

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
  admin: typeof admin;
  example: typeof example;
}>;
declare const fullApiWithMounts: typeof fullApi;

export declare const api: FilterApi<
  typeof fullApiWithMounts,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApiWithMounts,
  FunctionReference<any, "internal">
>;

export declare const components: {
  workflow: {
    functions: {
      start: FunctionReference<
        "mutation",
        "internal",
        {
          args: any;
          functionType:
            | { type: "query" }
            | { type: "mutation" }
            | { type: "action" };
          generationNumber: number;
          handle: string;
          journalId: string;
          name: string;
          workflowId: string;
        },
        null
      >;
    };
    journal: {
      load: FunctionReference<
        "query",
        "internal",
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
                workId?: string;
              }
            | {
                deadline: number;
                durationMs: number;
                inProgress: boolean;
                type: "sleep";
                workId?: string;
              };
          stepNumber: number;
          workflowId: string;
        }>
      >;
      pushEntry: FunctionReference<
        "mutation",
        "internal",
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
                workId?: string;
              }
            | {
                deadline: number;
                durationMs: number;
                inProgress: boolean;
                type: "sleep";
                workId?: string;
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
                workId?: string;
              }
            | {
                deadline: number;
                durationMs: number;
                inProgress: boolean;
                type: "sleep";
                workId?: string;
              };
          stepNumber: number;
          workflowId: string;
        }
      >;
      updateWorkId: FunctionReference<
        "mutation",
        "internal",
        { journalId: string; workId: string },
        null
      >;
    };
    pool: {
      onComplete: FunctionReference<
        "mutation",
        "internal",
        {
          context: any;
          result:
            | { kind: "success"; returnValue: any }
            | { error: string; kind: "failed" }
            | { kind: "canceled" };
          workId: string;
        },
        null
      >;
    };
    sleep: {
      start: FunctionReference<
        "mutation",
        "internal",
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
      cancel: FunctionReference<
        "mutation",
        "internal",
        { workflowId: string },
        null
      >;
      cleanup: FunctionReference<
        "mutation",
        "internal",
        { workflowId: string },
        boolean
      >;
      complete: FunctionReference<
        "mutation",
        "internal",
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
        "internal",
        {
          logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR";
          workflowArgs: any;
          workflowHandle: string;
          workflowName: string;
        },
        string
      >;
      getStatus: FunctionReference<
        "query",
        "internal",
        { workflowId: string },
        {
          inProgress: Array<{
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
                  workId?: string;
                }
              | {
                  deadline: number;
                  durationMs: number;
                  inProgress: boolean;
                  type: "sleep";
                  workId?: string;
                };
            stepNumber: number;
            workflowId: string;
          }>;
          logLevel: "DEBUG" | "INFO" | "WARN" | "ERROR";
          workflow: {
            _creationTime: number;
            _id: string;
            args: any;
            generationNumber: number;
            logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR";
            name?: string;
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
          };
        }
      >;
      sleep: FunctionReference<
        "mutation",
        "internal",
        { journalId: string },
        null
      >;
    };
  };
  workpool: {
    lib: {
      cancel: FunctionReference<
        "mutation",
        "internal",
        {
          id: string;
          logLevel: "DEBUG" | "TRACE" | "INFO" | "REPORT" | "WARN" | "ERROR";
        },
        any
      >;
      cancelAll: FunctionReference<
        "mutation",
        "internal",
        {
          before?: number;
          logLevel: "DEBUG" | "TRACE" | "INFO" | "REPORT" | "WARN" | "ERROR";
        },
        any
      >;
      enqueue: FunctionReference<
        "mutation",
        "internal",
        {
          config: {
            logLevel: "DEBUG" | "TRACE" | "INFO" | "REPORT" | "WARN" | "ERROR";
            maxParallelism: number;
          };
          fnArgs: any;
          fnHandle: string;
          fnName: string;
          fnType: "action" | "mutation" | "query";
          onComplete?: { context?: any; fnHandle: string };
          retryBehavior?: {
            base: number;
            initialBackoffMs: number;
            maxAttempts: number;
          };
          runAt: number;
        },
        string
      >;
      status: FunctionReference<
        "query",
        "internal",
        { id: string },
        | { previousAttempts: number; state: "pending" }
        | { previousAttempts: number; state: "running" }
        | { state: "finished" }
      >;
    };
  };
};
