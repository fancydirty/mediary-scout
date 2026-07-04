#!/bin/sh
# Reliable, SELF-VERIFYING self-host redeploy: pull latest, rebuild web, restart the
# stack, then PROVE the running container actually serves the pulled commit.
#
# Why this exists (2026-07-04 #88–#98): five deploys in a row silently kept serving OLD
# code — the box ran a stale image for a whole day before anyone noticed. The failure
# was invisible because the usual signals lie: host `git rev-parse HEAD` shows the new
# commit even when the container runs an old image, and watching the image hash is noisy
# (a fresh `--no-cache` build changes the hash purely from build non-determinism). So the
# real fix isn't a cache trick — it's a check: this script compares the RUNNING
# container's stamped commit (BUILD_COMMIT) against HEAD and exits non-zero on mismatch,
# which catches a stale build, a no-op `git pull`, or a container that wasn't recreated.
#
# It also does NOT use `--no-cache` (that throws away the cached `npm ci`, ~minutes):
# GIT_SHA=$(git rev-parse HEAD) is passed as a build arg the Dockerfile uses right before
# `COPY . .`, forcing a fresh source COPY + build per commit while deps stay cached.
#
# Usage (on the host, in the repo dir):   ./scripts/deploy.sh [extra `up` args]
set -eu

# Repo root = the script's parent dir. Plain dirname (no `--`, no `cd --`) for
# portability across /bin/sh implementations (busybox ash, dash, bash).
cd "$(dirname "$0")/.."

echo "==> git pull --ff-only"
git pull --ff-only

GIT_SHA="$(git rev-parse HEAD)"
export GIT_SHA
echo "==> Building web at commit ${GIT_SHA}"
# compose reads build.args GIT_SHA=${GIT_SHA} from the exported env above — no need to
# pass --build-arg. No --no-cache either: the GIT_SHA cache-bust already forces the
# source COPY + build to re-run, while keeping the (slow) npm ci layer cached.
docker compose build web

echo "==> Starting stack"
docker compose up -d "$@"

# Verify: the running container reports the commit we just built. This is the check
# that host `git rev-parse HEAD` CANNOT give you (a stale image outlives a pulled HEAD).
echo "==> Verifying running container commit"
# Retry rather than a fixed sleep: `up -d` returns before the container is
# exec-able, and slow hosts need longer — a flat `sleep 2` gives false negatives.
RUNNING=""
i=0
while [ "$i" -lt 15 ]; do
  RUNNING="$(docker compose exec -T web cat BUILD_COMMIT 2>/dev/null || true)"
  [ -n "$RUNNING" ] && break
  i=$((i + 1))
  sleep 1
done
[ -n "$RUNNING" ] || RUNNING='<no BUILD_COMMIT — image predates this fix; rebuild once more>'
echo "    expected (HEAD):        ${GIT_SHA}"
echo "    running container:      ${RUNNING}"
if [ "${RUNNING}" = "${GIT_SHA}" ]; then
  echo "==> OK: container is serving the freshly built commit."
else
  echo "==> WARNING: running container commit != HEAD. The build may have been cached"
  echo "    stale, or the container did not recreate. Investigate before trusting it."
  exit 1
fi
