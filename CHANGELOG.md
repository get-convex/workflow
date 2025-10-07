# Changelog

## 0.2.7 alpha

- Support for console logging & timing in workflows
- Support for Date.now() in workflows
- Batches the call to start steps
- Adds the workflow name to the workpool execution for observability
- Logs any error that shows up in the workflow body
- Will call onComplete for Workflows with startAsync that fail
  on their first invocation.
- Increases the max journal size from 1MB to 8MB
- Adds the WorkflowId type to step.workflowId

## 0.2.6

- Allow calling components directly from steps
- Allow passing a function handle so you can run steps that call components
- Fixes an issue with conflicting Workpool versions

## 0.2.5

- Call the onComplete handler for canceled workflows
- Canceling is more graceful - canceled steps generally won't print errors
- Allow `startAsync` to enqueue the starting of the workflow
  to allow starting many workflows safely.
