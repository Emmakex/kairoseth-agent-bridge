#!/usr/bin/env bash
set -euo pipefail

COMMAND="${1:-activate}"
CONTAINER_NAME="${KAB_CONTAINER_NAME:-agent-bridge-runtime}"
ROLLBACK_NAME="${KAB_ROLLBACK_CONTAINER_NAME:-${CONTAINER_NAME}.rollback}"
STATE_VOLUME="${KAB_STATE_VOLUME:-agent-bridge-state}"
HEALTH_TIMEOUT_SECONDS="${KAB_HEALTH_TIMEOUT_SECONDS:-60}"
RESTART_POLICY="${KAB_RESTART_POLICY:-unless-stopped}"
ENV_FILE="${KAB_ENV_FILE:-}"

log() {
  printf '[agent-bridge-docker] %s\n' "$*" >&2
}

fail() {
  log "ERROR: $*"
  exit 1
}

container_exists() {
  docker container inspect "$1" >/dev/null 2>&1
}

image_id() {
  docker image inspect --format '{{.Id}}' "$1"
}

container_image_id() {
  docker container inspect --format '{{.Image}}' "$1"
}

health_status() {
  docker container inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$1"
}

wait_healthy() {
  local name="$1"
  local timeout="$2"
  local started status
  started="$(date +%s)"

  while true; do
    if ! container_exists "$name"; then
      return 1
    fi

    status="$(health_status "$name")"
    case "$status" in
      healthy)
        return 0
        ;;
      unhealthy|none)
        return 1
        ;;
      starting)
        ;;
      *)
        return 1
        ;;
    esac

    if (( $(date +%s) - started >= timeout )); then
      return 1
    fi
    sleep 1
  done
}

validate_image_id() {
  [[ "$1" =~ ^sha256:[a-fA-F0-9]{64}$ ]] || fail "Invalid immutable Docker image ID: $1"
}

require_expected_current() {
  local expected="${KAB_EXPECTED_CURRENT_IMAGE_ID:-}"
  [[ -n "$expected" ]] || fail "KAB_EXPECTED_CURRENT_IMAGE_ID is required."
  validate_image_id "$expected"
  printf '%s' "${expected,,}"
}

require_expected_candidate() {
  local expected="${KAB_EXPECTED_CANDIDATE_IMAGE_ID:-}"
  [[ -n "$expected" ]] || fail "KAB_EXPECTED_CANDIDATE_IMAGE_ID is required."
  validate_image_id "$expected"
  printf '%s' "${expected,,}"
}

run_candidate() {
  local image="$1"
  local args=(
    docker run -d
    --name "$CONTAINER_NAME"
    --restart "$RESTART_POLICY"
    --mount "type=volume,src=${STATE_VOLUME},dst=/var/lib/agent-bridge"
  )

  if [[ -n "$ENV_FILE" ]]; then
    [[ -f "$ENV_FILE" ]] || fail "KAB_ENV_FILE does not exist: $ENV_FILE"
    args+=(--env-file "$ENV_FILE")
  fi

  args+=(--pull never "$image")
  "${args[@]}" >/dev/null
}

restore_backup_after_failed_activation() {
  local expected_previous="$1"

  log "Candidate activation failed; restoring exact previous container."
  if container_exists "$CONTAINER_NAME"; then
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi

  if ! container_exists "$ROLLBACK_NAME"; then
    log "Rollback target container is missing."
    return 1
  fi

  local backup_image
  backup_image="$(container_image_id "$ROLLBACK_NAME")"
  if [[ "${backup_image,,}" != "$expected_previous" ]]; then
    log "Rollback target image ID changed: ${backup_image}."
    return 1
  fi

  docker rename "$ROLLBACK_NAME" "$CONTAINER_NAME"
  docker start "$CONTAINER_NAME" >/dev/null

  if ! wait_healthy "$CONTAINER_NAME" "$HEALTH_TIMEOUT_SECONDS"; then
    log "Previous container did not return to healthy state."
    return 1
  fi

  local restored_image
  restored_image="$(container_image_id "$CONTAINER_NAME")"
  [[ "${restored_image,,}" == "$expected_previous" ]] || return 1
  log "Rollback restored ${expected_previous}."
}

activate() {
  local candidate_ref="${KAB_CANDIDATE_IMAGE:-}"
  [[ -n "$candidate_ref" ]] || fail "KAB_CANDIDATE_IMAGE is required."
  container_exists "$CONTAINER_NAME" || fail "Active container does not exist: $CONTAINER_NAME"
  ! container_exists "$ROLLBACK_NAME" || fail "Rollback container already exists: $ROLLBACK_NAME"

  local expected_current expected_candidate actual_current resolved_candidate
  expected_current="$(require_expected_current)"
  expected_candidate="$(require_expected_candidate)"
  actual_current="$(container_image_id "$CONTAINER_NAME")"
  resolved_candidate="$(image_id "$candidate_ref")"
  validate_image_id "$actual_current"
  validate_image_id "$resolved_candidate"

  [[ "${actual_current,,}" == "$expected_current" ]] || \
    fail "Active container image ID does not match the planned current image."
  [[ "${resolved_candidate,,}" == "$expected_candidate" ]] || \
    fail "Candidate reference does not resolve to the planned candidate image ID."

  if ! wait_healthy "$CONTAINER_NAME" "$HEALTH_TIMEOUT_SECONDS"; then
    fail "Current runtime must be healthy before activation."
  fi

  docker volume inspect "$STATE_VOLUME" >/dev/null 2>&1 || \
    fail "Durable state volume does not exist: $STATE_VOLUME"

  log "Stopping current runtime ${expected_current}."
  docker stop "$CONTAINER_NAME" >/dev/null
  docker rename "$CONTAINER_NAME" "$ROLLBACK_NAME"

  if run_candidate "$expected_candidate" && \
     wait_healthy "$CONTAINER_NAME" "$HEALTH_TIMEOUT_SECONDS"; then
    local active_image
    active_image="$(container_image_id "$CONTAINER_NAME")"
    if [[ "${active_image,,}" != "$expected_candidate" ]]; then
      log "Candidate became healthy under an unexpected image ID."
    else
      log "Candidate is healthy. Previous runtime retained as ${ROLLBACK_NAME}."
      return 0
    fi
  fi

  if restore_backup_after_failed_activation "$expected_current"; then
    # Dedicated result: activation failed, exact previous runtime restored.
    return 20
  fi

  log "Automatic rollback failed closed; operator intervention is required."
  return 21
}

manual_rollback() {
  local expected_previous
  expected_previous="$(require_expected_current)"
  container_exists "$ROLLBACK_NAME" || fail "Rollback container does not exist: $ROLLBACK_NAME"

  local backup_image
  backup_image="$(container_image_id "$ROLLBACK_NAME")"
  validate_image_id "$backup_image"
  [[ "${backup_image,,}" == "$expected_previous" ]] || \
    fail "Retained rollback container does not match the expected image ID."

  if container_exists "$CONTAINER_NAME"; then
    docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
    docker rm "$CONTAINER_NAME" >/dev/null
  fi

  docker rename "$ROLLBACK_NAME" "$CONTAINER_NAME"
  docker start "$CONTAINER_NAME" >/dev/null
  wait_healthy "$CONTAINER_NAME" "$HEALTH_TIMEOUT_SECONDS" || \
    fail "Rollback target did not become healthy."

  local restored_image
  restored_image="$(container_image_id "$CONTAINER_NAME")"
  [[ "${restored_image,,}" == "$expected_previous" ]] || \
    fail "Rollback restored an unexpected image ID."
  log "Manual rollback restored ${expected_previous}."
}

finalize() {
  local expected_previous
  expected_previous="$(require_expected_current)"
  container_exists "$ROLLBACK_NAME" || fail "Rollback container does not exist: $ROLLBACK_NAME"

  local backup_image
  backup_image="$(container_image_id "$ROLLBACK_NAME")"
  validate_image_id "$backup_image"
  [[ "${backup_image,,}" == "$expected_previous" ]] || \
    fail "Refusing to delete a rollback container with an unexpected image ID."

  docker rm "$ROLLBACK_NAME" >/dev/null
  log "Rollback target finalized and removed. Durable state volume was not modified."
}

case "$COMMAND" in
  activate)
    activate
    ;;
  rollback)
    manual_rollback
    ;;
  finalize)
    finalize
    ;;
  *)
    fail "Usage: activate-with-rollback.sh [activate|rollback|finalize]"
    ;;
esac
