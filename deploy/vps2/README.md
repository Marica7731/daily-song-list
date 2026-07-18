# VPS2 runtime deployment

Target host: `192.255.151.75`.

This deployment keeps the static frontend and the SQLite API on the same VPS. It serves `staging-ytb-song-rank.culua.com` first, then `ytb-song-rank.culua.com` after Cloudflare cutover.

All files live under service-specific subdirectories. Do not reuse `/var/www/song-search` or another existing project path:

- `/opt/culua/ytb-song-rank` for the git checkout and static frontend.
- `/var/lib/culua/ytb-song-rank` for SQLite databases and other runtime state.
- `/var/log/culua/ytb-song-rank` for service logs or future worker logs.

## One-time bootstrap

```bash
apt-get update
apt-get install -y git nginx python3 curl ca-certificates
mkdir -p /opt/culua /var/lib/culua/ytb-song-rank /var/log/culua/ytb-song-rank
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
git clone https://github.com/Marica7731/daily-song-list.git /opt/culua/ytb-song-rank
cd /opt/culua/ytb-song-rank
git checkout main
npm install --no-package-lock
python3 scripts/db/build-runtime-db.py --output /var/lib/culua/ytb-song-rank/song-rank.sqlite
chown -R www-data:www-data /var/lib/culua/ytb-song-rank /var/log/culua/ytb-song-rank
cp deploy/vps2/song-rank-api.service /etc/systemd/system/song-rank-api.service
cp deploy/vps2/song-rank-runtime-update.sh /usr/local/bin/song-rank-runtime-update.sh
chmod +x /usr/local/bin/song-rank-runtime-update.sh
cp deploy/vps2/song-rank-db-activate.sh /usr/local/bin/song-rank-db-activate.sh
chmod +x /usr/local/bin/song-rank-db-activate.sh
cp deploy/vps2/song-rank-runtime-update.service /etc/systemd/system/song-rank-runtime-update.service
cp deploy/vps2/song-rank-runtime-update.timer /etc/systemd/system/song-rank-runtime-update.timer
cp deploy/vps2/nginx-staging.conf /etc/nginx/sites-available/song-rank-staging.conf
ln -sf /etc/nginx/sites-available/song-rank-staging.conf /etc/nginx/sites-enabled/song-rank-staging.conf
nginx -t
systemctl daemon-reload
systemctl enable --now song-rank-api
systemctl enable --now song-rank-runtime-update.timer
systemctl reload nginx
```

## Rebuild and restart

VPS2 has 2 GiB memory, so the normal production update path builds SQLite in GitHub Actions and uploads the finished database to VPS2. Run this only to sync code and restart the API against the currently installed database:

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

The DB activation script is used by GitHub Actions after uploading a candidate DB:

```bash
CANDIDATE_DB=/var/lib/culua/ytb-song-rank/song-rank.sqlite.next \
EXPECTED_SHA256=<sha256> \
/usr/local/bin/song-rank-db-activate.sh
```

It probes `少女レイ`, keeps the previous database as `song-rank.sqlite.previous`, atomically replaces the active database, restarts the API, and emits `CODEX_RUNTIME_DB_ACTIVATE_OK`.

## Scheduled updates

GitHub Actions remains the source update mechanism. `Update core song-list data` runs hourly and commits refreshed data to `main`. `Deploy SQLite runtime DB` then builds SQLite on GitHub's runner and uploads the database to VPS2, where `song-rank-db-activate.sh` atomically replaces the active DB and restarts the API.

Required repository secret:

- `VPS2_PASSWORD`: root SSH password for `192.255.151.75`.

Useful commands:

```bash
systemctl status song-rank-runtime-update.timer
systemctl start song-rank-runtime-update.service
journalctl -u song-rank-runtime-update.service -n 100 --no-pager
tail -n 100 /var/log/culua/ytb-song-rank/runtime-update.log
cd /opt/culua/ytb-song-rank
npm run check:published:api -- http://127.0.0.1/
```

After production DNS points at VPS2, set the GitHub repository variable `DAILY_SONG_REQUIRE_PUBLISHED_API=1`. The hourly `update-core.yml` workflow will still update the source data, then verify the public static runtime and the public API. During migration, leave the variable unset or `0` so the static GitHub Pages site can continue passing before the API cutover.

The workflow also uploads a short-lived artifact containing `song-rank.sqlite` and a manifest with `commit_sha`, `run_id`, `built_at`, `sha256`, and `bytes`, so failed deployments can be inspected without rebuilding.

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
