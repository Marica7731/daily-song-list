# Repository agent rules

- Use bounded commands: normal checks 10-30 seconds, tests about 60 seconds, remote probes about 30 seconds. No unbounded waits.
- Keep this project GitHub-hosted: use GitHub web editor, Actions, or approved hosted execution. Do not use the VPS or clone/download repository history.
- Preserve immutable raw history under `data/static/v1/days/**`. Curation changes must use exact selectors and bounded batches.
- Publication order is: green `Check code`, bounded heartbeat/recovery/static update, then Pages. Recheck live meta, manifests, pagination, and entity details after publishing.
- Keep detailed per-run evidence in `docs/heartbeat-log.md`. Do not append round logs to this file.
