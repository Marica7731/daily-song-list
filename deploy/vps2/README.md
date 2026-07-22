# VPS2 runtime deployment

Target host: `192.255.151.75`.

This deployment keeps the static frontend and the SQLite API on the same VPS. It serves `staging-ytb-song-rank.culua.com` first, then `ytb-song-rank.culua.com` after Cloudflare cutover.

For release lane selection, slim commits, failure recording, and 2 GiB VPS guidance, see `docs/release-runbook.md`.

All files live under service-specific subdirectories. Do not reuse `/var/www/song-search` or another existing project path:

- `/opt/culua/ytb-song-rank` for the git checkout and static frontend.
- `/var/lib/culua/ytb-song-rank` for SQLite databases and other runtime state.
- `/var/log/culua/ytb-song-rank` for service logs or future worker logs.

## One-time bootstrap

```bash
apt-get update
apt-get install -y git nginx python3 curl ca-certificates rsync
mkdir -p /opt/culua /var/lib/culua/ytb-song-rank /var/log/culua/ytb-song-rank
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
git clone https://github.com/Marica7731/daily-song-list.git /opt/culua/ytb-song-rank
cd /opt/culua/ytb-song-rank
git checkout main
chown -R www-data:www-data /var/lib/culua/ytb-song-rank /var/log/culua/ytb-song-rank
cp deploy/vps2/song-rank-api.service /etc/systemd/system/song-rank-api.service
cp deploy/vps2/song-rank-runtime-update.sh /usr/local/bin/song-rank-runtime-update.sh
chmod +x /usr/local/bin/song-rank-runtime-update.sh
cp deploy/vps2/song-rank-db-activate.sh /usr/local/bin/song-rank-db-activate.sh
chmod +x /usr/local/bin/song-rank-db-activate.sh
cp deploy/vps2/song-rank-runtime-update.service /etc/systemd/system/song-rank-runtime-update.service
cp deploy/vps2/song-rank-runtime-update.timer /etc/systemd/system/song-rank-runtime-update.timer
cp deploy/vps2/nginx-staging.conf /etc/nginx/sites-available/song-rank-staging.conf
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/song-rank-staging.conf /etc/nginx/sites-enabled/song-rank-staging.conf
nginx -t
systemctl daemon-reload
systemctl enable song-rank-api
systemctl disable --now song-rank-runtime-update.timer
systemctl reload nginx
```

Do not build the SQLite database during VPS2 bootstrap. The 2 GiB host is expected to receive the first `song-rank.sqlite` from GitHub Actions, and `song-rank-db-activate.sh` will start `song-rank-api` after the uploaded database passes verification. If the first DB is missing, fix or rerun the GitHub Actions deploy instead of starting a full local build on VPS2.

The song-rank nginx site is installed as the port 80 default server. This keeps direct IP checks, staging DNS, and production DNS on the same route during cutover.

## Rebuild and restart

VPS2 has 2 GiB memory, so the normal production update path builds SQLite in GitHub Actions and rsyncs a verified candidate database to VPS2. Run this only to sync code and restart the API against the currently installed database:

```bash
/usr/local/bin/song-rank-runtime-update.sh
```

The default update script:

- Pulls `origin/main` with `git pull --ff-only`.
- Installs Node dependencies without creating `package-lock.json`.
- Restarts `song-rank-api` and checks `http://127.0.0.1:8765/healthz`.

The final stdout marker is `CODEX_RUNTIME_UPDATE_OK`.

On a larger host, set `BUILD_DB_ON_VPS=1` to build locally before restart:

```bash
BUILD_DB_ON_VPS=1 /usr/local/bin/song-rank-runtime-update.sh
```

The DB activation script is used by GitHub Actions after preparing a candidate DB:

```bash
CANDIDATE_DB=/var/lib/culua/ytb-song-rank/song-rank.sqlite.next \
EXPECTED_SHA256=<sha256> \
/usr/local/bin/song-rank-db-activate.sh
```

It probes `少女レイ`, keeps the previous database as `song-rank.sqlite.previous`, atomically replaces the active database, restarts the API, and emits `CODEX_RUNTIME_DB_ACTIVATE_OK`.

## Scheduled updates

GitHub Actions remains the source update mechanism. `Update core song-list data` runs hourly and commits refreshed data to `main`. `Deploy SQLite runtime DB` then builds SQLite on GitHub's runner and rsyncs it to VPS2, where `song-rank-db-activate.sh` atomically replaces the active DB and restarts the API.

Keep `song-rank-runtime-update.timer` installed but disabled on the 2 GiB VPS2 production host. The timer is only a manual fallback for code sync and health restart; enabling it for routine production updates can make the checkout drift from the database built by GitHub Actions.

Do not run full `npm run db:build`, full `npm run update:core`, runtime shard generation, or bulk YouTube backfill on the 2 GiB production VPS2. Use GitHub Actions or a larger temporary machine for those jobs, then let VPS2 run activation, health checks, and small smoke queries.

Required repository secret:

- `VPS2_PASSWORD`: root SSH password for `192.255.151.75`.

Useful commands:

```bash
systemctl status song-rank-api
journalctl -u song-rank-api -n 100 --no-pager
systemctl restart song-rank-api
ss -ltnp | grep -E ':(80|443|8765) '
ls -lh /var/lib/culua/ytb-song-rank/song-rank.sqlite*
cat /var/lib/culua/ytb-song-rank/song-rank.sqlite.manifest.json
systemctl status song-rank-runtime-update.timer
systemctl start song-rank-runtime-update.service
journalctl -u song-rank-runtime-update.service -n 100 --no-pager
tail -n 100 /var/log/culua/ytb-song-rank/runtime-update.log
cd /opt/culua/ytb-song-rank
npm run check:published:api -- http://127.0.0.1/
```

After production DNS points at VPS2, set the GitHub repository variable `DAILY_SONG_REQUIRE_PUBLISHED_API=1`. The hourly `update-core.yml` workflow will still update the source data, then verify the production SQLite/API contract with `npm run check:published:api`. During migration, leave the variable unset or `0` so the static GitHub Pages site can continue passing before the API cutover.

`Deploy SQLite runtime DB` runs on direct `main` pushes that touch runtime code, source data, VSinger shards, or `data/external/youtube-channel-discovery/accepted/*.json`, and after `Update core song-list data` completes successfully. Each run resolves the latest `origin/main` revision before building, so an hourly data refresh that lands during a deploy will be picked up by the next deploy instead of leaving VPS2 pinned to an older commit.

The publish step first checks the free bytes under `/var/lib/culua/ytb-song-rank`. When the host can hold the active DB plus a run-scoped candidate DB and 1 GiB of margin, it copies the active database to a path such as `song-rank.sqlite.next.<run>.<attempt>`, then uses `rsync --inplace --partial --compress` to transfer only changed blocks from the GitHub-built SQLite file. The active database is not touched until the candidate sha256 and query probe pass inside `song-rank-db-activate.sh`.

If VPS2 does not have enough room for both the active and candidate DB, the workflow checks that direct overwrite still has enough growth room for `new_db_size - active_db_size` plus 1 GiB of margin. It then disables the runtime update timer, stops `song-rank-api`, verifies the API is no longer active, rsyncs `artifacts/runtime/song-rank.sqlite` directly to `/var/lib/culua/ytb-song-rank/song-rank.sqlite`, validates the sha256 and query probe with `CODEX_RUNTIME_DB_DIRECT_ACTIVATE=1`, then restarts and health-checks the API. This low-space path has no `.previous` rollback copy; if the direct upload or activation fails, the workflow attempts to stop the API again and the deploy should be rerun instead of serving a partial database.

The workflow always uploads the small manifest artifact; set repository variable `DAILY_SONG_UPLOAD_DB_ARTIFACT=1` only when you intentionally need the full `song-rank.sqlite` artifact for inspection.

Failed deploys remove their candidate DB automatically. To clean historical candidates by hand:

```bash
find /var/lib/culua/ytb-song-rank -maxdepth 1 -type f \
  \( -name 'song-rank.sqlite.next.*' -o -name 'song-rank.sqlite.next.*.manifest.json' \) \
  -delete
```

If a newly activated DB is bad, roll back to the previous active DB kept by the activation script:

```bash
systemctl stop song-rank-api
cp /var/lib/culua/ytb-song-rank/song-rank.sqlite /var/lib/culua/ytb-song-rank/song-rank.sqlite.bad.$(date -u +%Y%m%dT%H%M%SZ)
cp /var/lib/culua/ytb-song-rank/song-rank.sqlite.previous /var/lib/culua/ytb-song-rank/song-rank.sqlite
systemctl start song-rank-api
curl -fsS http://127.0.0.1:8765/healthz
```

## GitHub Actions failure handling

The routine update path is:

1. `Update core song-list data` refreshes and commits source/static data to `main`.
2. `Deploy SQLite runtime DB` is triggered by the successful `workflow_run`, resolves the latest `origin/main`, builds `artifacts/runtime/song-rank.sqlite`, uploads the manifest artifact for 14 days, rsyncs the DB to VPS2, activates it, checks VPS2 health, and verifies the production API.
3. After production cutover, `Update core song-list data` checks the public homepage and `https://ytb-song-rank.culua.com/` with `npm run check:published:api`.

Troubleshooting map:

- Missing or wrong `VPS2_PASSWORD`: the `Install sshpass` or first SSH step fails before touching VPS2.
- DB build failure: inspect `Build runtime database`; no remote candidate is uploaded.
- Local API artifact failure: inspect `Verify runtime API artifact`; no remote candidate is activated.
- Upload or activation failure: inspect `Upload and activate database`; remote candidates named `song-rank.sqlite.next.<run>.<attempt>` are removed on workflow failure. If the log shows `CODEX_RUNTIME_DB_UPLOAD_MODE direct-inplace`, check that `song-rank-api` is stopped, then rerun the deploy to finish the interrupted in-place upload before restarting the public API.
- Health or production API failure: inspect `Verify VPS2 health endpoint` and `Verify production API`, then run `journalctl -u song-rank-api -n 100 --no-pager` and `curl -fsS http://127.0.0.1:8765/healthz` on VPS2. The production API check retries briefly after activation because the public endpoint can return a transient HTML error page while nginx/upstream state settles.
- Concurrency cancellation is expected when a newer deploy run starts; the newest successful deploy is authoritative.

Manual rerun options:

- Re-run the failed GitHub Actions job from the web UI when the source commit is still desired.
- Use `workflow_dispatch` on `Deploy SQLite runtime DB` to rebuild from current `origin/main`.
- Download the workflow artifact only for inspection. By default it contains only the manifest; enable `DAILY_SONG_UPLOAD_DB_ARTIFACT=1` before rerunning only when the full SQLite artifact is needed.

## Migration checklist

To move this deployment to another host, copy:

- `/opt/culua/ytb-song-rank` or reclone the same git commit.
- `/var/lib/culua/ytb-song-rank/song-rank.sqlite` if rebuilding from source data is not desired.
- `/usr/local/bin/song-rank-runtime-update.sh`.
- `/etc/systemd/system/song-rank-api.service`.
- `/etc/systemd/system/song-rank-runtime-update.service`.
- `/etc/systemd/system/song-rank-runtime-update.timer`.
- `/etc/nginx/sites-available/song-rank-staging.conf`.

The service has no dependency on the old `culua` VPS paths.

## DNS and cutover

1. Keep `staging-ytb-song-rank.culua.com` as an A record pointing to `192.255.151.75`.
2. Verify `http://staging-ytb-song-rank.culua.com/healthz`, `/api/meta`, `/api/rankings`, source detail loading, and the frontend.
3. Only after staging is healthy, change `ytb-song-rank.culua.com` from the GitHub Pages CNAME to an A record pointing to `192.255.151.75`.
4. In Cloudflare, set the production record to proxied when the origin HTTP route is healthy.

Production verification:

```bash
curl -fsS https://ytb-song-rank.culua.com/healthz
npm run check:published:api -- https://ytb-song-rank.culua.com/
```

Rollback to GitHub Pages:

1. Change `ytb-song-rank.culua.com` back to CNAME `marica7731.github.io`.
2. Set Cloudflare proxy to DNS-only for that CNAME.
3. Verify the static site with `npm run check:published -- https://ytb-song-rank.culua.com/`.

Do not cache `/api/*` at Cloudflare. The API already returns short-lived `Cache-Control` headers and the frontend depends on current ranking/source-detail reads.

## Cloudflare HTTPS with sing-box on 443

This VPS already uses `sing-box` on TCP/UDP 443, so nginx is intentionally kept on port 80 and the song-rank API listens only on `127.0.0.1:8765`. Do not make nginx bind 443 unless the existing proxy service is being migrated.

For Cloudflare proxied HTTPS to reach this origin while preserving the existing proxy service, the current host uses the `sing-box` Trojan inbound `fallback` field to forward unauthenticated TLS traffic to local nginx on port 80. The official sing-box Trojan inbound documentation defines `fallback` as fallback server configuration with `server` and `server_port`: https://sing-box.sagernet.org/configuration/inbound/trojan/

Safe change procedure:

```bash
cp /etc/sing-box/config.json /etc/sing-box/config.json.codex-backup-$(date -u +%Y%m%dT%H%M%SZ)
# edit only the trojan inbound on listen_port 443:
# "fallback": { "server": "127.0.0.1", "server_port": 80 }
/usr/local/bin/sing-box check -c /etc/sing-box/config.json
systemctl restart sing-box
systemctl is-active sing-box
curl -k --resolve ytb-song-rank.culua.com:443:192.255.151.75 https://ytb-song-rank.culua.com/healthz
```

If the direct-origin HTTPS check fails, restore the timestamped backup, restart `sing-box`, and roll production DNS back to GitHub Pages until the 443 conflict is resolved.
