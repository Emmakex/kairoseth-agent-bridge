#!/usr/bin/env bash
set -euo pipefail

CONTAINER="agent-bridge-rollback-drill"
ROLLBACK_CONTAINER="${CONTAINER}.rollback"
VOLUME="agent-bridge-rollback-drill-state"
PREVIOUS_IMAGE="agent-bridge-rollback-previous:ci"
CANDIDATE_IMAGE="agent-bridge-rollback-candidate:ci"

cleanup() {
  docker rm -f "$CONTAINER" "$ROLLBACK_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  docker image rm -f "$CANDIDATE_IMAGE" "$PREVIOUS_IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

wait_healthy() {
  local name="$1"
  local timeout="$2"
  local started status
  started="$(date +%s)"
  while true; do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name")"
    [[ "$status" == "healthy" ]] && return 0
    [[ "$status" == "unhealthy" || "$status" == "none" ]] && return 1
    (( $(date +%s) - started < timeout )) || return 1
    sleep 1
  done
}

docker build -f tests/fixtures/docker-rollback/healthy.Dockerfile -t "$PREVIOUS_IMAGE" .
docker build -f tests/fixtures/docker-rollback/unhealthy.Dockerfile -t "$CANDIDATE_IMAGE" .
docker volume create "$VOLUME" >/dev/null

docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --mount "type=volume,src=${VOLUME},dst=/var/lib/agent-bridge" \
  --pull never \
  "$PREVIOUS_IMAGE" >/dev/null

wait_healthy "$CONTAINER" 15

PREVIOUS_ID="$(docker image inspect --format '{{.Id}}' "$PREVIOUS_IMAGE")"
CANDIDATE_ID="$(docker image inspect --format '{{.Id}}' "$CANDIDATE_IMAGE")"
ACTIVE_BEFORE="$(docker inspect --format '{{.Image}}' "$CONTAINER")"
test "$ACTIVE_BEFORE" = "$PREVIOUS_ID"
test "$(docker exec "$CONTAINER" cat /var/lib/agent-bridge/previous-runtime.marker)" = "previous-runtime"

set +e
KAB_CONTAINER_NAME="$CONTAINER" \
KAB_ROLLBACK_CONTAINER_NAME="$ROLLBACK_CONTAINER" \
KAB_STATE_VOLUME="$VOLUME" \
KAB_HEALTH_TIMEOUT_SECONDS=10 \
KAB_CANDIDATE_IMAGE="$CANDIDATE_IMAGE" \
KAB_EXPECTED_CURRENT_IMAGE_ID="$PREVIOUS_ID" \
KAB_EXPECTED_CANDIDATE_IMAGE_ID="$CANDIDATE_ID" \
  bash packaging/docker/activate-with-rollback.sh activate
ACTIVATION_STATUS=$?
set -e

test "$ACTIVATION_STATUS" -eq 20

ACTIVE_AFTER="$(docker inspect --format '{{.Image}}' "$CONTAINER")"
test "$ACTIVE_AFTER" = "$PREVIOUS_ID"
test "$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER")" = "healthy"
test "$(docker exec "$CONTAINER" cat /var/lib/agent-bridge/previous-runtime.marker)" = "previous-runtime"
test "$(docker exec "$CONTAINER" cat /var/lib/agent-bridge/candidate-attempt.marker)" = "candidate-attempt"

if docker container inspect "$ROLLBACK_CONTAINER" >/dev/null 2>&1; then
  echo "stale rollback container remained after automatic restore" >&2
  exit 1
fi

RUNNING_COUNT="$(docker ps --filter "name=^/${CONTAINER}$" --format '{{.ID}}' | wc -l | tr -d ' ')"
test "$RUNNING_COUNT" -eq 1

printf 'Installed Docker rollback drill passed: candidate failed, exact previous image %s restored with durable state.\n' "$PREVIOUS_ID"
