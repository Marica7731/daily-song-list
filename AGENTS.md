# Repository agent rules

## WDC server-side release execution

- Keep GitHub-hosted Ubuntu as the portable controller, syntax gate, and regression gate. Heavy PostgreSQL snapshot materialization, ranking pages, serving-store build, release assembly, and temporary storage run only on WDC. Windows and the Mac runner must not carry PostgreSQL payloads or WDC release databases.
- VPS2 remains the authoritative PostgreSQL host. A release may create only one run-scoped `www-data` relay bound to `127.0.0.1` and connected to `/var/run/postgresql/.s.PGSQL.5432`. WDC reaches it through a strict-known-host SSH tunnel; never expose PostgreSQL publicly or add a database password.
- The relay has one cumulative **16,000,000,000-byte** bidirectional wire budget and at most **2** concurrent connections. Only the driver-level transport-loss signatures enumerated by `_is_retryable_pg_transport_error()` may checkpoint, reconnect, and resume. Identity or data errors must fail closed, and every reconnect must recheck active revision, content SHA-256, and source commit.
- Transfer only the explicitly listed, hash-manifested sparse source tree to the exact WDC run root. The tree must remain below 100 MB and must not contain `.git`. Never clone or copy a repository, checkout history, object pack, Mac worktree, source index, or production dataset for a WDC release.
- One run owns exactly `/opt/culua/ytb-song-rank/.build/dsl-wdc-<run>-<attempt>`, `/var/tmp/dsl-wdc-volume-<run>-<attempt>`, and `/run/dsl-wdc-<run>-<attempt>`. All require matching owner markers. Cleanup must derive targets from run ID and attempt and may remove only those exact roots after stopping their exact build, guard, and tunnel units.
- Run the heavy build under cgroup v2 with `MemoryMax=2,684,354,560`, `MemorySwapMax=1,073,741,824`, `CPUQuota=300%`, `TasksMax=96`, and `RuntimeMaxSec=32400`. The build script must verify its actual cgroup files before materialization. Attach the sparse loop backing file with direct I/O and fail closed unless `losetup` reports `DIO=1` before `mkfs`; otherwise the backing-file page cache can consume the cgroup independently of the inner SQLite cache.
- Install only the hashes in `scripts/migration/requirements-wdc-linux.txt` into the exact run volume with binary-only, `--no-deps`, no-cache pip options. Never install into global or user site-packages.
- `materialize-pg-release-snapshot.py` keeps one `REPEATABLE READ READ ONLY` transaction. Validate the same active revision, content SHA-256, and source commit before build, in the materialized metadata, immediately before activation, and after activation.
- Do not create a release archive. Once bundle creation finishes, delete page/frontend/dependency intermediates inside the fixed volume, keep the hard-linked immutable release, copy it once into `releases/.incoming-<sha>.<run>-<attempt>`, then same-filesystem rename it to `releases/<sha>`.
- Preserve rollback until local correctness, complete public API/UI correctness, and a continuous 10-minute observation succeed. Only then finalize and retain the exact current and previous 64-hex release directories.

## WDC storage hard boundary

The following production rule is mandatory for every agent, script, workflow, and manual deployment touching WDC:

- Daily Song List project-associated storage must stay below **40,000,000,000 bytes**. Reaching the line is a failure.
- Each build uses one fixed sparse ext4 loop filesystem with a capacity of **32,000,000,000 bytes** below its exact owner-marked `/var/tmp/dsl-wdc-volume-<run>-<attempt>` root. `/var/tmp` must be a real directory on the same host filesystem as the project. The checker counts both project logical bytes and allocated host blocks without following links, while the volume remains outside the project tree so its sparse logical length cannot inflate project accounting.
- The immutable final release must stay below **16,000,000,000 logical bytes**. Symlinks, sockets, devices, other non-regular entries, empty releases, or ambiguous measurements fail closed.
- Preserve at least **20,000,000,000 bytes** of WDC host filesystem availability at preflight, throughout the build, before/after the one release copy, and after finalization.
- Before any large write, prove all boundaries independently: `host free - 32,000,000,000 >= 20,000,000,000`, `current logical project + 134,217,728 < 40,000,000,000`, and `current logical project + 16,000,000,000 + 134,217,728 < 40,000,000,000`. The release copy is the only new full project-tree copy.
- If any capacity boundary or required measurement cannot be proved, the deployment must stop before writing to WDC.
- A separate exact storage-guard unit checks the project, fixed volume, and host reserve every 30 seconds and stops the build on any breach. Missing, malformed, or stale evidence is failure, not permission to continue.
- WDC writes are restricted to the exact control/secret roots, the exact incoming candidate, the final 64-hex release, and the six installer control targets. Never scan, move, truncate, or delete sibling projects or unrelated temporary content to make room.
- On failure/cancellation, a candidate release may be removed only when `current` names another release, `.rollback-<sha>` is absent, and `realpath` proves it is that exact direct child. Active or rollback-protected releases are preserved as recovery evidence.
- After finalization, record project bytes, filesystem availability, current/previous identities, two-release retention, and absence of the exact control root, secret root, relay root, transient units, incoming directory, and rollback state.

These limits take precedence over completing a release. If any gate cannot be proved, leave production unchanged and report the exact boundary.

## Operator state and handoff

- [`docs/WDC_RELEASE_RUNBOOK.md`](docs/WDC_RELEASE_RUNBOOK.md) is the mandatory operator and handoff entry. If it disagrees with the workflow or scripts, stop; verify the implementation and update code plus documentation in the same reviewed change.
- At takeover, read the platform goal, `CODEX_GOAL.md`, current repo root/branch/status, current `main`, and all active core/accepted/WDC runs. Historical run IDs, revisions, release hashes, and green tests are evidence only, never current authority.
- Only the total controller may commit, push, merge, dispatch, cancel, disable or enable a workflow, run remote cleanup, activate a release, or mark the production goal complete. A documentation/review subcontrol must stop with an uncommitted diff for review.
- Use the existing `vps-wdc` and `vps-racknerd` SSH aliases and GitHub CLI credential store. Never place a host address, credential value, Git extra header, private key, or secret environment value in commands, logs, screenshots, or documentation.
- The release state machine is strict: legal core/accepted completion -> one latest-main WDC run -> resource and owner-marker monitoring -> same-round code fix if needed -> CI and merge -> one latest-main rerun -> API/data/browser acceptance -> 10-minute observation -> exact cleanup -> re-enable `update-core.yml` -> goal complete.
- Identity, data, capacity, ownership, and path ambiguity are non-retryable. Do not create a second run. Only the exact bounded transport-loss predicate in `materialize-pg-release-snapshot.py` may resume from a durable source checkpoint after identity revalidation.
- A canonical song entity is not an occurrence, source row, video row, or historical revision. A roughly tens-of-thousands canonical count never proves deletion of the much larger history. Cleanup must never touch canonical PostgreSQL tables, production song data, immutable inputs, or backups.
- Manual worktree cleanup requires all four proofs at once: an exact owner marker, an exact run/worktree registration, no process/file-handle reference, and clean Git status. Unknown ownership, user changes, shared `.git`/index state, active processes, or incomplete proof blocks deletion. Never use broad recursive targets, globs, `git clean`, or unscoped worktree pruning.
- Production delivery is incomplete until the exact release identity passes health/meta, all four ranking views, sources, title/artist search, scope filters, real browser interaction, the full 10-minute observation, residue checks, and confirmation that `update-core.yml` is active again.
