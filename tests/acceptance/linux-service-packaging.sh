#!/usr/bin/env bash
set -euo pipefail

ROOT="$(mktemp -d)"
cleanup() {
  rm -rf "$ROOT"
}
trap cleanup EXIT

INSTALL_ROOT="$ROOT/opt/agent-bridge"
CONFIG_ROOT="$ROOT/etc/agent-bridge"
STATE_ROOT="$ROOT/var/lib/agent-bridge"
UNIT_DIR="$ROOT/etc/systemd/system"
SYSTEMD_STATE="$ROOT/systemd-state"
FAKE_SYSTEMCTL="$ROOT/systemctl"
PREVIOUS_DIGEST="$(printf 'a%.0s' {1..64})"
CANDIDATE_DIGEST="$(printf 'b%.0s' {1..64})"
PREVIOUS_COMMIT="$(printf '1%.0s' {1..40})"
CANDIDATE_COMMIT="$(printf '2%.0s' {1..40})"

cat > "$FAKE_SYSTEMCTL" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
STATE="${FAKE_SYSTEMD_STATE:?}"
case "${1:-}" in
  start)
    printf 'active\n' > "$STATE"
    ;;
  stop)
    printf 'inactive\n' > "$STATE"
    ;;
  is-active)
    [[ "$(cat "$STATE" 2>/dev/null || true)" == "active" ]]
    ;;
  daemon-reload|enable|disable)
    ;;
  *)
    echo "unsupported fake systemctl command: ${1:-}" >&2
    exit 2
    ;;
esac
SH
chmod +x "$FAKE_SYSTEMCTL"

make_bundle() {
  local name="$1"
  local version="$2"
  local digest="$3"
  local commit="$4"
  local health="$5"
  local stage="$ROOT/stage-$name/$name"
  local archive="$ROOT/$name.tar.gz"

  mkdir -p "$stage/dist/src/cli" "$stage/node_modules" "$stage/packaging/linux"
  cp packaging/linux/agent-bridge.service "$stage/packaging/linux/"
  cp packaging/linux/agent-bridge.env.example "$stage/packaging/linux/"
  printf '{}\n' > "$stage/package.json"
  printf '{}\n' > "$stage/package-lock.json"
  printf 'fixture\n' > "$stage/node_modules/.fixture"

  cat > "$stage/runtime-release.json" <<JSON
{
  "schemaVersion": "kab.runtime-release.v1",
  "technicalProductId": "agent-bridge",
  "packageVersion": "$version",
  "artifactSha256": "$digest",
  "sourceCommit": "$commit",
  "channel": "stable"
}
JSON

  if [[ "$health" == "healthy" ]]; then
    cat > "$stage/dist/src/cli/agent-bridge-runtime.js" <<'JS'
import fs from "node:fs";
import path from "node:path";
if (process.argv[2] !== "healthcheck") process.exit(2);
const state = process.env.KAB_STATE_DIR;
if (!state) process.exit(2);
fs.mkdirSync(state, { recursive: true });
fs.writeFileSync(path.join(state, "previous-health.marker"), "healthy\n");
process.exit(0);
JS
  else
    cat > "$stage/dist/src/cli/agent-bridge-runtime.js" <<'JS'
import fs from "node:fs";
import path from "node:path";
if (process.argv[2] !== "healthcheck") process.exit(2);
const state = process.env.KAB_STATE_DIR;
if (!state) process.exit(2);
fs.mkdirSync(state, { recursive: true });
fs.writeFileSync(path.join(state, "candidate-attempt.marker"), "attempted\n");
process.exit(1);
JS
  fi

  tar -C "$ROOT/stage-$name" -czf "$archive" "$name"
  printf '%s' "$archive"
}

PREVIOUS_BUNDLE="$(make_bundle previous-linux 1.0.0 "$PREVIOUS_DIGEST" "$PREVIOUS_COMMIT" healthy)"
CANDIDATE_BUNDLE="$(make_bundle candidate-linux 1.1.0 "$CANDIDATE_DIGEST" "$CANDIDATE_COMMIT" unhealthy)"
PREVIOUS_BUNDLE_SHA="$(sha256sum "$PREVIOUS_BUNDLE" | awk '{print $1}')"
CANDIDATE_BUNDLE_SHA="$(sha256sum "$CANDIDATE_BUNDLE" | awk '{print $1}')"

COMMON_INSTALL_ENV=(
  KAB_TEST_MODE=1
  KAB_INSTALL_ROOT="$INSTALL_ROOT"
  KAB_CONFIG_ROOT="$CONFIG_ROOT"
  KAB_STATE_ROOT="$STATE_ROOT"
  KAB_SYSTEMD_UNIT_DIR="$UNIT_DIR"
  KAB_NODE_BIN="$(command -v node)"
)

env "${COMMON_INSTALL_ENV[@]}" \
  bash packaging/linux/install-bundle.sh "$PREVIOUS_BUNDLE" "$PREVIOUS_BUNDLE_SHA" >/dev/null

PREVIOUS_RELEASE="$INSTALL_ROOT/releases/sha256-$PREVIOUS_DIGEST"
CANDIDATE_RELEASE="$INSTALL_ROOT/releases/sha256-$CANDIDATE_DIGEST"
test "$(realpath "$INSTALL_ROOT/current")" = "$PREVIOUS_RELEASE"
test -f "$UNIT_DIR/agent-bridge.service"
test -f "$CONFIG_ROOT/agent-bridge.env"
printf '\nCUSTOM_OPERATOR_VALUE=preserve-me\n' >> "$CONFIG_ROOT/agent-bridge.env"

# A second install adds immutable release bytes but cannot silently switch current.
env "${COMMON_INSTALL_ENV[@]}" \
  bash packaging/linux/install-bundle.sh "$CANDIDATE_BUNDLE" "$CANDIDATE_BUNDLE_SHA" >/dev/null

test "$(realpath "$INSTALL_ROOT/current")" = "$PREVIOUS_RELEASE"
grep -q '^CUSTOM_OPERATOR_VALUE=preserve-me$' "$CONFIG_ROOT/agent-bridge.env"

# Durable state is external to both immutable releases.
mkdir -p "$STATE_ROOT"
printf 'durable-state\n' > "$STATE_ROOT/durable.marker"
printf 'active\n' > "$SYSTEMD_STATE"

set +e
FAKE_SYSTEMD_STATE="$SYSTEMD_STATE" \
KAB_INSTALL_ROOT="$INSTALL_ROOT" \
KAB_STATE_ROOT="$STATE_ROOT" \
KAB_SYSTEMCTL_BIN="$FAKE_SYSTEMCTL" \
KAB_NODE_BIN="$(command -v node)" \
KAB_HEALTH_TIMEOUT_SECONDS=2 \
KAB_CANDIDATE_RELEASE_PATH="$CANDIDATE_RELEASE" \
KAB_EXPECTED_CURRENT_ARTIFACT_SHA256="$PREVIOUS_DIGEST" \
KAB_EXPECTED_CANDIDATE_ARTIFACT_SHA256="$CANDIDATE_DIGEST" \
  bash packaging/linux/activate-with-rollback.sh activate
ACTIVATION_STATUS=$?
set -e

test "$ACTIVATION_STATUS" -eq 20
test "$(realpath "$INSTALL_ROOT/current")" = "$PREVIOUS_RELEASE"
test ! -e "$INSTALL_ROOT/previous"
test "$(cat "$SYSTEMD_STATE")" = "active"
test "$(cat "$STATE_ROOT/durable.marker")" = "durable-state"
test "$(cat "$STATE_ROOT/candidate-attempt.marker")" = "attempted"
test "$(cat "$STATE_ROOT/previous-health.marker")" = "healthy"

# Operator hardening and no-ingress design must remain explicit in the unit.
grep -q '^User=agent-bridge$' packaging/linux/agent-bridge.service
grep -q '^StateDirectory=agent-bridge$' packaging/linux/agent-bridge.service
grep -q '^NoNewPrivileges=true$' packaging/linux/agent-bridge.service
grep -q '^ProtectSystem=strict$' packaging/linux/agent-bridge.service
grep -q '^CapabilityBoundingSet=$' packaging/linux/agent-bridge.service
! grep -q '^Listen' packaging/linux/agent-bridge.service

printf 'Installed Linux rollback drill passed: candidate failed, exact previous digest %s restored with durable state.\n' "$PREVIOUS_DIGEST"
