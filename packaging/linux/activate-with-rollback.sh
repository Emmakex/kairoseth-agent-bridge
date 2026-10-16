#!/usr/bin/env bash
set -euo pipefail

COMMAND="${1:-activate}"
INSTALL_ROOT="${KAB_INSTALL_ROOT:-/opt/agent-bridge}"
STATE_ROOT="${KAB_STATE_ROOT:-/var/lib/agent-bridge}"
SYSTEMCTL_BIN="${KAB_SYSTEMCTL_BIN:-systemctl}"
NODE_BIN="${KAB_NODE_BIN:-/usr/bin/node}"
SERVICE_NAME="${KAB_SERVICE_NAME:-agent-bridge.service}"
HEALTH_TIMEOUT_SECONDS="${KAB_HEALTH_TIMEOUT_SECONDS:-60}"
CURRENT_LINK="$INSTALL_ROOT/current"
PREVIOUS_LINK="$INSTALL_ROOT/previous"
RELEASES_ROOT="$INSTALL_ROOT/releases"

log() {
  printf '[agent-bridge-linux] %s\n' "$*" >&2
}

fail() {
  log "ERROR: $*"
  exit 1
}

validate_digest() {
  [[ "$1" =~ ^[a-fA-F0-9]{64}$ ]] || fail "Invalid runtime artifact SHA-256: $1"
}

canonical_release_path() {
  local value="$1"
  [[ -d "$value" ]] || fail "Release directory does not exist: $value"
  local canonical
  canonical="$(realpath -e "$value")"
  case "$canonical" in
    "$RELEASES_ROOT"/sha256-*) ;;
    *) fail "Release path is outside the managed releases directory: $canonical" ;;
  esac
  printf '%s' "$canonical"
}

descriptor_digest() {
  local release_path="$1"
  "$NODE_BIN" - "$release_path/runtime-release.json" <<'NODE'
const fs = require('node:fs');
const descriptor = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (
  descriptor.schemaVersion !== 'kab.runtime-release.v1' ||
  descriptor.technicalProductId !== 'agent-bridge' ||
  typeof descriptor.artifactSha256 !== 'string' ||
  !/^[a-f0-9]{64}$/i.test(descriptor.artifactSha256)
) process.exit(1);
process.stdout.write(descriptor.artifactSha256.toLowerCase());
NODE
}

validate_release_binding() {
  local release_path="$1"
  local expected_digest="$2"
  validate_digest "$expected_digest"
  local canonical actual_digest expected_name
  canonical="$(canonical_release_path "$release_path")"
  actual_digest="$(descriptor_digest "$canonical")" || fail "Release descriptor is invalid: $canonical"
  expected_digest="${expected_digest,,}"
  expected_name="sha256-$expected_digest"
  [[ "$(basename "$canonical")" == "$expected_name" ]] || \
    fail "Release directory name is not bound to the expected artifact digest."
  [[ "$actual_digest" == "$expected_digest" ]] || \
    fail "Release descriptor digest does not match the expected artifact digest."
  printf '%s' "$canonical"
}

current_release() {
  [[ -L "$CURRENT_LINK" ]] || fail "Current release pointer is missing: $CURRENT_LINK"
  canonical_release_path "$CURRENT_LINK"
}

previous_release() {
  [[ -L "$PREVIOUS_LINK" ]] || fail "Previous release pointer is missing: $PREVIOUS_LINK"
  canonical_release_path "$PREVIOUS_LINK"
}

atomic_link() {
  local target="$1"
  local link="$2"
  local temp="${link}.new.$$"
  rm -f "$temp"
  ln -s "$target" "$temp"
  mv -Tf "$temp" "$link"
}

runtime_healthcheck() {
  local release_path="$1"
  env KAB_STATE_DIR="$STATE_ROOT" \
    "$NODE_BIN" "$release_path/dist/src/cli/agent-bridge-runtime.js" healthcheck >/dev/null 2>&1
}

service_healthy() {
  local release_path="$1"
  "$SYSTEMCTL_BIN" is-active --quiet "$SERVICE_NAME" >/dev/null 2>&1 \
    && runtime_healthcheck "$release_path"
}

wait_healthy() {
  local release_path="$1"
  local started
  started="$(date +%s)"
  while true; do
    if service_healthy "$release_path"; then
      return 0
    fi
    if (( $(date +%s) - started >= HEALTH_TIMEOUT_SECONDS )); then
      return 1
    fi
    sleep 1
  done
}

restore_previous_after_failure() {
  local expected_previous="$1"
  local previous
  previous="$(previous_release)" || return 1
  previous="$(validate_release_binding "$previous" "$expected_previous")" || return 1

  log "Candidate activation failed; restoring exact previous Linux release."
  "$SYSTEMCTL_BIN" stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  atomic_link "$previous" "$CURRENT_LINK"
  "$SYSTEMCTL_BIN" start "$SERVICE_NAME" >/dev/null

  if ! wait_healthy "$previous"; then
    log "Previous Linux release did not return to healthy state."
    return 1
  fi

  local restored
  restored="$(current_release)" || return 1
  [[ "$restored" == "$previous" ]] || return 1
  rm -f "$PREVIOUS_LINK"
  log "Rollback restored sha256-${expected_previous,,}."
}

activate() {
  local candidate="${KAB_CANDIDATE_RELEASE_PATH:-}"
  local expected_current="${KAB_EXPECTED_CURRENT_ARTIFACT_SHA256:-}"
  local expected_candidate="${KAB_EXPECTED_CANDIDATE_ARTIFACT_SHA256:-}"
  [[ -n "$candidate" ]] || fail "KAB_CANDIDATE_RELEASE_PATH is required."
  validate_digest "$expected_current"
  validate_digest "$expected_candidate"
  [[ ! -e "$PREVIOUS_LINK" && ! -L "$PREVIOUS_LINK" ]] || \
    fail "Previous release pointer already exists; finalize or rollback the prior activation first."

  local current candidate_path
  current="$(current_release)"
  current="$(validate_release_binding "$current" "$expected_current")"
  candidate_path="$(validate_release_binding "$candidate" "$expected_candidate")"
  [[ "$current" != "$candidate_path" ]] || fail "Candidate is already the current release."

  if ! wait_healthy "$current"; then
    fail "Current Linux runtime must be healthy before activation."
  fi

  "$SYSTEMCTL_BIN" stop "$SERVICE_NAME" >/dev/null
  atomic_link "$current" "$PREVIOUS_LINK"
  atomic_link "$candidate_path" "$CURRENT_LINK"

  if "$SYSTEMCTL_BIN" start "$SERVICE_NAME" >/dev/null \
    && wait_healthy "$candidate_path"; then
    local active
    active="$(current_release)"
    if [[ "$active" == "$candidate_path" ]]; then
      log "Candidate is healthy. Exact previous release retained at $PREVIOUS_LINK."
      return 0
    fi
    log "Candidate became healthy under an unexpected current pointer."
  fi

  if restore_previous_after_failure "$expected_current"; then
    return 20
  fi

  log "Automatic Linux rollback failed closed; operator intervention is required."
  return 21
}

manual_rollback() {
  local expected_previous="${KAB_EXPECTED_ROLLBACK_ARTIFACT_SHA256:-}"
  validate_digest "$expected_previous"
  local previous
  previous="$(previous_release)"
  previous="$(validate_release_binding "$previous" "$expected_previous")"

  "$SYSTEMCTL_BIN" stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  atomic_link "$previous" "$CURRENT_LINK"
  "$SYSTEMCTL_BIN" start "$SERVICE_NAME" >/dev/null
  wait_healthy "$previous" || fail "Rollback target did not become healthy."
  rm -f "$PREVIOUS_LINK"
  log "Manual rollback restored sha256-${expected_previous,,}."
}

finalize() {
  local expected_previous="${KAB_EXPECTED_ROLLBACK_ARTIFACT_SHA256:-}"
  validate_digest "$expected_previous"
  local previous
  previous="$(previous_release)"
  validate_release_binding "$previous" "$expected_previous" >/dev/null
  rm -f "$PREVIOUS_LINK"
  log "Previous release pointer finalized. Release bytes and durable state were not deleted."
}

case "$COMMAND" in
  activate) activate ;;
  rollback) manual_rollback ;;
  finalize) finalize ;;
  *) fail "Usage: activate-with-rollback.sh [activate|rollback|finalize]" ;;
esac
