# Changelog

## 1.1.0

- Protect completed files and reject overlapping downloads.
- Use task-specific temporary files; publish without replacing existing files.
- Validate filenames, URLs, checksums, and rate limits.
- Restrict retry/removal to finished tasks after cleanup; reset retry notifications.
- Notify the calling session and keep mirror preferences per task.
- Escape dashboard content; require same-origin POST requests for mutations.
- Support browser launching on Windows, macOS, and Linux.
- Add type checks, regression tests, and cross-platform CI.
- Add bilingual documentation and collaborative creation credits.

## 1.0.0

- Initial implementation by DeepSeek V4.1 Flash: background downloads, Ollama pulls,
  a local dashboard, and automatic AI notifications.
