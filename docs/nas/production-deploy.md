# Production NAS deployment guide

This guide documents the safe production deployment process for `warehouse-system`.
It intentionally excludes SSH hosts, usernames, passwords, API keys, and local
credential file paths.

## Safety rules

- Deploy only from a clean local git worktree.
- Run the backend test suite before touching production.
- Push the deployment branch first, so the deployed commit is recoverable.
- Back up production code and compose files before replacing files.
- Never delete or replace the production data directory.
- Preserve the existing production Docker volume and bind mount layout.
- Do not run `rsync --delete` against the production project root.
- Do not commit `.env`, SSH credentials, command history with secrets, or NAS
  account details.

## Production data paths

Production runtime data is stored under the project data mount:

```text
/volume1/docker/warehouse-system/data
```

This directory contains files such as:

```text
warehouse.db
warehouse.db-wal
warehouse.db-shm
uploads/
thumbnails/
```

These files and directories must survive every deployment.

## Local preflight

From the local repository:

```bash
git status --short --branch
npm --prefix server test
docker build -t warehouse-system-preflight:local ./server
```

The worktree must be clean or contain only the intended deployment commit.
Tests and local Docker build must pass before proceeding.

## Push branch

Push the deployment branch without merging it into `main`:

```bash
git push origin <deployment-branch>
```

Keep the branch name and commit hash in the deployment notes.

## Production backup

On the production NAS, create a timestamped backup directory outside `data`:

```bash
cd /volume1/docker/warehouse-system
mkdir -p backups
backup_dir="backups/deploy-before-<short-sha>-<yyyymmdd-hhmmss>"
mkdir -p "$backup_dir"
cp -a docker-compose.yml public server scripts docs archive README.md "$backup_dir"/
```

If a file or directory does not exist, record that in the deployment notes
instead of failing silently.

## Upload code safely

Package the local repository while excluding generated and runtime data:

```bash
tar \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='server/node_modules' \
  --exclude='data' \
  --exclude='data-test' \
  --exclude='.DS_Store' \
  -czf /tmp/warehouse-system-deploy.tar.gz \
  README.md .gitignore docker-compose.yml public server scripts docs archive
```

Extract it in the production project directory without deleting `data`:

```bash
cd /volume1/docker/warehouse-system
tar -xzf /tmp/warehouse-system-deploy.tar.gz
rm -f /tmp/warehouse-system-deploy.tar.gz
```

## Build and restart

Use the existing production compose file:

```bash
cd /volume1/docker/warehouse-system
sudo /usr/local/bin/docker-compose build
sudo /usr/local/bin/docker-compose up -d
```

The production Dockerfile uses Node 22 because current native dependencies
require Node 20 or newer. If the build fails, do not retry blindly; preserve the
running container and investigate the build log first.

## Verification

After restart:

```bash
sudo /usr/local/bin/docker ps --filter name=warehouse
curl -fsS http://<production-host>:3000/api/health
curl -fsS -o /dev/null -w '%{http_code}\n' http://<production-host>:3000/admin.html
curl -fsS -o /dev/null -w '%{http_code}\n' http://<production-host>:3000/employee.html
```

Check production data still exists:

```bash
ls -lah /volume1/docker/warehouse-system/data
test -s /volume1/docker/warehouse-system/data/warehouse.db
test -d /volume1/docker/warehouse-system/data/uploads
```

For thumbnail deployments, also verify that `THUMBNAILS_DIR=/data/thumbnails`
is set in compose and that thumbnail files are served through `/thumbnails/...`.

## Rollback

If the new container fails health checks:

```bash
cd /volume1/docker/warehouse-system
cp -a <backup-dir>/* .
sudo /usr/local/bin/docker-compose up -d --build
```

Do not restore over the production `data` directory unless the rollback is
specifically a data recovery operation.
