# Changelog

## 0.2.6

- Allow calling components directly from steps
- Allow passing a function handle so you can run steps that call components
- Fixes an issue with conflicting Workpool versions

## 0.2.5

- Call the onComplete handler for canceled workflows
- Canceling is more graceful - canceled steps generally won't print errors
- Allow `startAsync` to enqueue the starting of the workflow
  to allow starting many workflows safely.
