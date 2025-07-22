# Changelog

## 0.2.6 alpha

- Allow calling components directly from steps

## 0.2.5

- Call the onComplete handler for canceled workflows
- Canceling is more graceful - canceled steps generally won't print errors
- Allow `startAsync` to enqueue the starting of the workflow
  to allow starting many workflows safely.
