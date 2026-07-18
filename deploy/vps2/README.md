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

Run this after pushing a new data or API commit when you want an immediate update instead of waiting for the timer:

```bash
/usr/local/bin/song-rank-runtime-update.sh
```

The update script:

- Pulls `origin/main` with `git pull --ff-only`.
- Builds a new database under `/var/lib/culua/ytb-song-rank/song-rank.sqlite.next.*`.
- Runs `scripts/db/query-runtime-db.py` against the temp database.
- Keeps the previous database as `/var/lib/culua/ytb-song-rank/song-rank.sqlite.previous`.
- Replaces the active database only after a successful build and probe.
- Restarts `song-rank-api` and checks `http://127.0.0.1:8765/healthz`.

The final stdout marker is `CODEX_RUNTIME_UPDATE_OK`. A lower-level database build success is `CODEX_RUNTIME_DB_BUILD_OK`.

## Scheduled updates

GitHub Actions remains the source update mechanism. `Update core song-list data` runs hourly and commits refreshed data to `main`. VPS2 then pulls `main` and rebuilds SQLite through `song-rank-runtime-update.timer` every 10 minutes.

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

If the 2 GiB VPS cannot complete the builder, move only the DB build to GitHub Actions: have the action upload `song-rank.sqlite` plus a manifest containing `commit_sha`, `run_id`, `built_at`, `sha256`, and `bytes`; then change the VPS2 update script to download, verify sha256, atomically replace the DB, and restart the API. Keep raw source data in git or in the artifact manifest so the database remains reproducible.

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
