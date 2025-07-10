/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as journal from "../journal.js";
import type * as logging from "../logging.js";
import type * as model from "../model.js";
import type * as pool from "../pool.js";
import type * as utils from "../utils.js";
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
  journal: typeof journal;
  logging: typeof logging;
  model: typeof model;
  pool: typeof pool;
  utils: typeof utils;
  workflow: typeof workflow;
}>;
export type Mounts = {
  journal: {
    load: FunctionReference<
      "query",
      "public",
      { workflowId: string },
      {
        journalEntries: Array<{
          _creationTime: number;
          _id: string;
          step: {
            args: any;
            argsSize: number;
            completedAt?: number;
            functionType: "query" | "mutation" | "action";
            handle: string;
            inProgress: boolean;
            name: string;
            runResult?:
              | { kind: "success"; returnValue: any }
              | { error: string; kind: "failed" }
              | { kind: "canceled" };
            startedAt: number;
            workId?: string;
          };
          stepNumber: number;
          workflowId: string;
        }>;
        logLevel: "DEBUG" | "TRACE" | "INFO" | "REPORT" | "WARN" | "ERROR";
        ok: boolean;
        workflow: {
          _creationTime: number;
          _id: string;
          args: any;
          generationNumber: number;
          logLevel?: any;
          name?: string;
          onComplete?: { context?: any; fnHandle: string };
          runResult?:
            | { kind: "success"; returnValue: any }
            | { error: string; kind: "failed" }
            | { kind: "canceled" };
          startedAt?: any;
          state?: any;
          workflowHandle: string;
        };
      }
    >;
    startStep: FunctionReference<
      "mutation",
      "public",
      {
        generationNumber: number;
        name: string;
        retry?:
          | boolean
          | { base: number; initialBackoffMs: number; maxAttempts: number };
        schedulerOptions?: { runAt?: number } | { runAfter?: number };
        step: {
          args: any;
          argsSize: number;
          completedAt?: number;
          functionType: "query" | "mutation" | "action";
          handle: string;
          inProgress: boolean;
          name: string;
          runResult?:
            | { kind: "success"; returnValue: any }
            | { error: string; kind: "failed" }
            | { kind: "canceled" };
          startedAt: number;
          workId?: string;
        };
        workflowId: string;
        workpoolOptions?: {
          defaultRetryBehavior?: {
            base: number;
            initialBackoffMs: number;
            maxAttempts: number;
          };
          logLevel?: "DEBUG" | "TRACE" | "INFO" | "REPORT" | "WARN" | "ERROR";
          maxParallelism?: number;
          retryActionsByDefault?: boolean;
        };
      },
      {
        _creationTime: number;
        _id: string;
        step: {
          args: any;
          argsSize: number;
          completedAt?: number;
          functionType: "query" | "mutation" | "action";
          handle: string;
          inProgress: boolean;
          name: string;
          runResult?:
            | { kind: "success"; returnValue: any }
            | { error: string; kind: "failed" }
            | { kind: "canceled" };
          startedAt: number;
          workId?: string;
        };
        stepNumber: number;
        workflowId: string;
      }
    >;
  };
  workflow: {
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
      boolean
    >;
    complete: FunctionReference<
      "mutation",
      "public",
      {
        generationNumber: number;
        runResult:
          | { kind: "success"; returnValue: any }
          | { error: string; kind: "failed" }
          | { kind: "canceled" };
        workflowId: string;
      },
      null
    >;
    create: FunctionReference<
      "mutation",
      "public",
      {
        maxParallelism?: number;
        onComplete?: { context?: any; fnHandle: string };
        startAsync?: boolean;
        workflowArgs: any;
        workflowHandle: string;
        workflowName: string;
      },
      string
    >;
    getStatus: FunctionReference<
      "query",
      "public",
      { workflowId: string },
      {
        inProgress: Array<{
          _creationTime: number;
          _id: string;
          step: {
            args: any;
            argsSize: number;
            completedAt?: number;
            functionType: "query" | "mutation" | "action";
            handle: string;
            inProgress: boolean;
            name: string;
            runResult?:
              | { kind: "success"; returnValue: any }
              | { error: string; kind: "failed" }
              | { kind: "canceled" };
            startedAt: number;
            workId?: string;
          };
          stepNumber: number;
          workflowId: string;
        }>;
        logLevel: "DEBUG" | "TRACE" | "INFO" | "REPORT" | "WARN" | "ERROR";
        workflow: {
          _creationTime: number;
          _id: string;
          args: any;
          generationNumber: number;
          logLevel?: any;
          name?: string;
          onComplete?: { context?: any; fnHandle: string };
          runResult?:
            | { kind: "success"; returnValue: any }
            | { error: string; kind: "failed" }
            | { kind: "canceled" };
          startedAt?: any;
          state?: any;
          workflowHandle: string;
        };
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

export declare const components: {
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
