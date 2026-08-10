# Repository agent rules

## WDC storage hard boundary

The following production rule is mandatory for every agent, script, workflow, and manual deployment touching WDC:

- Daily Song List may use at most **40 GB = 40,000,000,000 bytes** of project-associated storage on WDC. Reaching the line is a failure; it is not a warning threshold.
- Before any archive upload, extraction, release switch, or rollback preparation, measure only the exact project root `/opt/culua/ytb-song-rank` and calculate the conservative peak as `current project bytes + compressed archive bytes + extracted release bytes + one release-sized rollback reserve`.
- If the projected peak is greater than or equal to `40,000,000,000`, or if the measurement is missing, malformed, or ambiguous, the operation **must stop before writing to WDC**.
- Keep at least `5,000,000,000` bytes of filesystem headroom after the conservative peak. A deployment must fail closed instead of consuming space needed by unrelated workloads.
- WDC writes and cleanup are restricted to `/opt/culua/ytb-song-rank` and the exact current-run files `/tmp/dsl-wdc-<64-hex-release>.tar.gz` and `/tmp/install-wdc-release.sh`. Never scan, move, truncate, or delete sibling projects or unrelated `/tmp` content to make room.
- Preserve rollback until all local and public correctness gates succeed. Only then retain the exact current and previous 64-hex release directories; deletion must be limited to verified direct children of `/opt/culua/ytb-song-rank/releases`.
- After finalization, record the project byte count, filesystem availability, current/previous release identities, and absence of incoming, rollback, and current-run temporary residue. Do not call a deployment complete without this evidence.

These limits take precedence over completing a release. If they cannot be proved, leave production unchanged and report the blocked gate.
