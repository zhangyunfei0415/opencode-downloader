# Changelog

## 1.2.0

- Configure 1–16 concurrent tasks (default 3); lowering the limit never interrupts running tasks.
- Add bilingual dashboard settings for concurrency, per-task HTTP rate defaults, directory, notifications, and mirrors.
- Apply HTTP rate changes live; task overrides support returning to the default.
- Persist settings atomically to `~/.config/opencode/downloader.json`.
- Keep Ollama optional and explicitly exclude it from HTTP rate controls.
- Add regression coverage for scheduling, settings validation, persistence, and live rate changes.

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
