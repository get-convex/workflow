# Changelog

## 0.3.3

- Export EventId type and vEventId validator from @convex-dev/workflow

## 0.3.2

- The WorkflowCtx (`ctx`) now matches the type of GenericActionCtx for basic
  functionality like `ctx.runMutation` / etc. so it's easier to use with things
  like components that only need that API. e.g. calling `resend.sendEmail(ctx,`
  with the Workflow's ctx.

## 0.3.1

- Bumps the workpool version dependency and automatically registers it in tests.

## 0.3.0

- Adds /test and /\_generated/component.js entrypoints
- Drops commonjs support
- Improves source mapping for generated files
- Changes to a statically generated component API

## 0.2.8 alpha

- Adds asynchronous events - wait for an event in a workflow, send events
  asynchronously - allows pause/resume, human-in-loop, etc.
- Supports nested workflows with step.runWorkflow.
- Surfaces return value of the workflow in the status
- You can start a workflow directly from the CLI / dashboard without having to
  make a mutation to call workflow.start:
  - `{ fn: "path/to/file:workflowName", args: { ...your workflow args } }`
- Reduces read bandwidth when reading the journal after running many steps in
  parallel.
- Simplifies the onComplete type requirement so you can accept a workflowId as a
  string. This helps when you have statically generated types which can't do
  branded strings.
- Adds a /test entrypoint to make testing easier
- Exports the `WorkflowCtx` and `WorkflowStep` types
- Support for Math.random via seeded PRNG.

## 0.2.7

- Support for console logging & timing in workflows
- Support for Date.now() in workflows
- Batches the call to start steps
- Adds the workflow name to the workpool execution for observability
- Logs any error that shows up in the workflow body
- Will call onComplete for Workflows with startAsync that fail on their first
  invocation.
- Increases the max journal size from 1MB to 8MB
- Adds the WorkflowId type to step.workflowId
- Exposes /test entrypoint to make testing easier

## 0.2.6

- Allow calling components directly from steps
- Allow passing a function handle so you can run steps that call components
- Fixes an issue with conflicting Workpool versions

## 0.2.5

- Call the onComplete handler for canceled workflows
- Canceling is more graceful - canceled steps generally won't print errors
- Allow `startAsync` to enqueue the starting of the workflow to allow starting
  many workflows safely.
