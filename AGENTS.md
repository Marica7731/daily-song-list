# Repository agent rules

## Mac-first release execution

- Keep the Ubuntu `ubuntu_gate` job as the portable syntax and regression gate. The snapshot, serving-store build, bundle build, direct transfer, activation, and online checks run only on `[self-hosted, macOS, ARM64, daily-song-list-mac]`.
- Every Mac run owns exactly `/Users/be/codex-temp/dsl-wdc-sync-<run>-<attempt>`. The workflow must fail if it already exists, never let concurrent work share it, and remove it only when its run marker matches.
- Batch materialization uses `/Users/be/.local/bin/python3` and installs only the hashes in `scripts/migration/requirements-wdc-mac.txt` into the exact run-local `python-deps` directory with binary-only, `--no-deps`, and no-cache pip options. Never install into global or user site-packages. The runner must also provide Node, OpenSSH, and `tar`. Do not fall back to VPS2 materialization or split one release across snapshots.
- Each exact Mac run root has a hard accounting ceiling of **32,000,000,000 bytes** and must preserve **15,000,000,000 bytes** of filesystem availability outside its budget. Before build, reserve the entire remaining run budget; after bundle creation, recursively sum regular-file `st_size` again with Python `lstat` and `shutil.disk_usage`. Any symlink, socket, device, other non-regular entry, missing measurement, limit reach, or reserve breach fails closed. Never scan or clean another Mac run directory to make room.
- VPS2 may start only the bounded relay as `www-data`, listening on `127.0.0.1` and connecting to `/var/run/postgresql/.s.PGSQL.5432`. The Mac reaches it through strict-known-host SSH forwarding. Do not expose a public PostgreSQL port or add a database password.
- `materialize-pg-release-snapshot.py` must keep its single `REPEATABLE READ READ ONLY` transaction. Validate the same active revision, source content SHA-256, and source commit at start, after build, immediately before activation, and after activation.
- Never upload the release through a GitHub artifact or place a large archive on VPS2. Stream one bounded tar directly from the Mac bundle directory into the exact WDC current-run `release.tar.gz.part`.
- Always derive cleanup targets from run ID and attempt, even when a prior step did not populate `GITHUB_ENV`. Stop the exact tunnel and relay, close the exact PostgreSQL application backend, and remove only the exact VPS2 relay root, Mac run root, and WDC incoming root.
- On a failed/cancelled run, an extracted `releases/<sha>` may be removed only when `current` names a different release, `.rollback-<sha>` is absent, and `realpath` proves the candidate is that exact direct child. If it is active or rollback state exists, preserve it as recovery evidence and fail cleanup explicitly.

## WDC storage hard boundary

The following production rule is mandatory for every agent, script, workflow, and manual deployment touching WDC:

- Daily Song List may use at most **40 GB = 40,000,000,000 bytes** of project-associated storage on WDC. Reaching the line is a failure; it is not a warning threshold.
- Before the first WDC current-run write, measure only the exact project root `/opt/culua/ytb-song-rank` and calculate the conservative peak as `current project bytes + bounded compressed archive bytes + one extracted release + 134,217,728-byte control-backup allowance`. After the archive exists, it is already included in current project bytes, so the gate is `current project bytes + one extracted release + the same control-backup allowance`.
- Before either WDC capacity decision, use `lstat` to total exactly the six installer control targets: server, index, hashed app, systemd unit, nginx available, and nginx enabled. Existing targets must be regular files or symlinks and their combined `st_size` must remain below **128 MiB = 134,217,728 bytes**. The installer backs up only these controls; it never copies `serving.sqlite`.
- Extraction occurs in `releases/.incoming-<sha>.*` and activation uses a same-filesystem `mv` into `releases/<sha>`. That rename does not allocate a second release or database copy, so capacity arithmetic must not count two extracted releases.
- If the projected peak is greater than or equal to `40,000,000,000`, or if the measurement is missing, malformed, or ambiguous, the operation **must stop before writing to WDC**.
- Keep at least `5,000,000,000` bytes of filesystem headroom after the conservative peak. A deployment must fail closed instead of consuming space needed by unrelated workloads.
- WDC writes and cleanup are restricted to `/opt/culua/ytb-song-rank` and the exact current-run directory `/opt/culua/ytb-song-rank/incoming/dsl-wdc-<run>-<attempt>-<64-hex-release>`. Never scan, move, truncate, or delete sibling projects or unrelated temporary content to make room.
- Preserve rollback until all local and public correctness gates succeed. Only then retain the exact current and previous 64-hex release directories; deletion must be limited to verified direct children of `/opt/culua/ytb-song-rank/releases`.
- After finalization, record the project byte count, filesystem availability, current/previous release identities, and absence of incoming, rollback, and current-run temporary residue. Do not call a deployment complete without this evidence.

These limits take precedence over completing a release. If they cannot be proved, leave production unchanged and report the blocked gate.
