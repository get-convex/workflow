/* prettier-ignore-start */

/* eslint-disable */
/**
 * Generated utilities for implementing server-side Convex query and mutation functions.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import {
  ActionBuilder,
  AnyComponents,
  HttpActionBuilder,
  MutationBuilder,
  QueryBuilder,
  GenericActionCtx,
  GenericMutationCtx,
  GenericQueryCtx,
  GenericDatabaseReader,
  GenericDatabaseWriter,
  FunctionReference,
} from "convex/server";
import type { DataModel } from "./dataModel.js";

type GenericCtx =
  | GenericActionCtx<DataModel>
  | GenericMutationCtx<DataModel>
  | GenericQueryCtx<DataModel>;

/**
 * Define a query in this Convex app's public API.
 *
 * This function will be allowed to read your Convex database and will be accessible from the client.
 *
 * @param func - The query function. It receives a {@link QueryCtx} as its first argument.
 * @returns The wrapped query. Include this as an `export` to name it and make it accessible.
 */
export declare const query: QueryBuilder<DataModel, "public">;

/**
 * Define a query that is only accessible from other Convex functions (but not from the client).
 *
 * This function will be allowed to read from your Convex database. It will not be accessible from the client.
 *
 * @param func - The query function. It receives a {@link QueryCtx} as its first argument.
 * @returns The wrapped query. Include this as an `export` to name it and make it accessible.
 */
export declare const internalQuery: QueryBuilder<DataModel, "internal">;

/**
 * Define a mutation in this Convex app's public API.
 *
 * This function will be allowed to modify your Convex database and will be accessible from the client.
 *
 * @param func - The mutation function. It receives a {@link MutationCtx} as its first argument.
 * @returns The wrapped mutation. Include this as an `export` to name it and make it accessible.
 */
export declare const mutation: MutationBuilder<DataModel, "public">;

/**
 * Define a mutation that is only accessible from other Convex functions (but not from the client).
 *
 * This function will be allowed to modify your Convex database. It will not be accessible from the client.
 *
 * @param func - The mutation function. It receives a {@link MutationCtx} as its first argument.
 * @returns The wrapped mutation. Include this as an `export` to name it and make it accessible.
 */
export declare const internalMutation: MutationBuilder<DataModel, "internal">;

/**
 * Define an action in this Convex app's public API.
 *
 * An action is a function which can execute any JavaScript code, including non-deterministic
 * code and code with side-effects, like calling third-party services.
 * They can be run in Convex's JavaScript environment or in Node.js using the "use node" directive.
 * They can interact with the database indirectly by calling queries and mutations using the {@link ActionCtx}.
 *
 * @param func - The action. It receives an {@link ActionCtx} as its first argument.
 * @returns The wrapped action. Include this as an `export` to name it and make it accessible.
 */
export declare const action: ActionBuilder<DataModel, "public">;

/**
 * Define an action that is only accessible from other Convex functions (but not from the client).
 *
 * @param func - The function. It receives an {@link ActionCtx} as its first argument.
 * @returns The wrapped function. Include this as an `export` to name it and make it accessible.
 */
export declare const internalAction: ActionBuilder<DataModel, "internal">;

/**
 * Define an HTTP action.
 *
 * This function will be used to respond to HTTP requests received by a Convex
 * deployment if the requests matches the path and method where this action
 * is routed. Be sure to route your action in `convex/http.js`.
 *
 * @param func - The function. It receives an {@link ActionCtx} as its first argument.
 * @returns The wrapped function. Import this function from `convex/http.js` and route it to hook it up.
 */
export declare const httpAction: HttpActionBuilder;

/**
 * A set of services for use within Convex query functions.
 *
 * The query context is passed as the first argument to any Convex query
 * function run on the server.
 *
 * This differs from the {@link MutationCtx} because all of the services are
 * read-only.
 */
export type QueryCtx = GenericQueryCtx<DataModel>;

/**
 * A set of services for use within Convex mutation functions.
 *
 * The mutation context is passed as the first argument to any Convex mutation
 * function run on the server.
 */
export type MutationCtx = GenericMutationCtx<DataModel>;

/**
 * A set of services for use within Convex action functions.
 *
 * The action context is passed as the first argument to any Convex action
 * function run on the server.
 */
export type ActionCtx = GenericActionCtx<DataModel>;

/**
 * An interface to read from the database within Convex query functions.
 *
 * The two entry points are {@link DatabaseReader.get}, which fetches a single
 * document by its {@link Id}, or {@link DatabaseReader.query}, which starts
 * building a query.
 */
export type DatabaseReader = GenericDatabaseReader<DataModel>;

/**
 * An interface to read from and write to the database within Convex mutation
 * functions.
 *
 * Convex guarantees that all writes within a single mutation are
 * executed atomically, so you never have to worry about partial writes leaving
 * your data in an inconsistent state. See [the Convex Guide](https://docs.convex.dev/understanding/convex-fundamentals/functions#atomicity-and-optimistic-concurrency-control)
 * for the guarantees Convex provides your functions.
 */
export type DatabaseWriter = GenericDatabaseWriter<DataModel>;

export declare const components: {
  workflow: {
    fetch: {
      executeFetch: FunctionReference<
        "action",
        "internal",
        { body?: ArrayBuffer; headers: any; method: string; url: string },
        { body: ArrayBuffer; headers: any; status: number; statusText: string }
      >;
    };
    index: {
      completeSleep: FunctionReference<
        "mutation",
        "internal",
        { generationNumber: number; journalId: string; workflowId: string },
        null
      >;
      completeWorkflow: FunctionReference<
        "mutation",
        "internal",
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
        "internal",
        { workflowArgs: any; workflowHandle: string },
        string
      >;
      loadJournal: FunctionReference<
        "query",
        "internal",
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
        "internal",
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
        "internal",
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
        "internal",
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
        "internal",
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
};

/* prettier-ignore-end */
