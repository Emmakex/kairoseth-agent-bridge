#!/usr/bin/env bash
set -euo pipefail

BUNDLE="${1:-}"
EXPECTED_SHA256="${2:-}"
INSTALL_ROOT="${KAB_INSTALL_ROOT:-/opt/agent-bridge}"
CONFIG_ROOT="${KAB_CONFIG_ROOT:-/etc/agent-bridge}"
STATE_ROOT="${KAB_STATE_ROOT:-/var/lib/agent-bridge}"
UNIT_DIR="${KAB_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
SYSTEMCTL_BIN="${KAB_SYSTEMCTL_BIN:-systemctl}"
NODE_BIN="${KAB_NODE_BIN:-/usr/bin/node}"
TEST_MODE="${KAB_TEST_MODE:-0}"
SERVICE_USER="${KAB_SERVICE_USER:-agent-bridge}"
SERVICE_GROUP="${KAB_SERVICE_GROUP:-agent-bridge}"

log() {
  printf '[agent-bridge-linux] %s\n' "$*" >&2
}

fail() {
  log "ERROR: $*"
  exit 1
}

[[ -n "$BUNDLE" && -n "$EXPECTED_SHA256" ]] || \
  fail "Usage: install-bundle.sh <linux-bundle.tar.gz> <expected-sha256>"
[[ -f "$BUNDLE" ]] || fail "Bundle does not exist: $BUNDLE"
[[ "$EXPECTED_SHA256" =~ ^[a-fA-F0-9]{64}$ ]] || fail "Expected bundle SHA-256 is invalid."

ACTUAL_SHA256="$(sha256sum "$BUNDLE" | awk '{print $1}')"
[[ "${ACTUAL_SHA256,,}" == "${EXPECTED_SHA256,,}" ]] || \
  fail "Linux bundle SHA-256 does not match the expected digest."

NODE_MAJOR="$($NODE_BIN -p 'Number(process.versions.node.split(".")[0])')"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge 22 ]] || \
  fail "Agent Bridge requires Node.js 22 or newer."

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mapfile -t ARCHIVE_PATHS < <(tar -tzf "$BUNDLE")
[[ "${#ARCHIVE_PATHS[@]}" -gt 0 ]] || fail "Linux bundle is empty."
for path in "${ARCHIVE_PATHS[@]}"; do
  [[ "$path" != /* ]] || fail "Linux bundle contains an absolute path."
  case "/$path/" in
    *"/../"*) fail "Linux bundle contains parent-directory traversal." ;;
  esac
done

mapfile -t TOP_LEVEL < <(
  printf '%s\n' "${ARCHIVE_PATHS[@]}" \
    | sed '/^$/d' \
    | cut -d/ -f1 \
    | sort -u
)
[[ "${#TOP_LEVEL[@]}" -eq 1 ]] || fail "Linux bundle must contain exactly one top-level directory."

tar -xzf "$BUNDLE" -C "$TMP_DIR" --no-same-owner --no-same-permissions
STAGED_ROOT="$TMP_DIR/${TOP_LEVEL[0]}"
DESCRIPTOR="$STAGED_ROOT/runtime-release.json"
[[ -f "$DESCRIPTOR" ]] || fail "Linux bundle is missing runtime-release.json."
[[ -f "$STAGED_ROOT/package.json" ]] || fail "Linux bundle is missing package.json."
[[ -f "$STAGED_ROOT/dist/src/cli/agent-bridge-runtime.js" ]] || \
  fail "Linux bundle is missing the runtime CLI."
[[ -d "$STAGED_ROOT/node_modules" ]] || fail "Linux bundle is missing production dependencies."

mapfile -t RELEASE_FIELDS < <(
  "$NODE_BIN" - "$DESCRIPTOR" <<'NODE'
const fs = require('node:fs');
const descriptor = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sha = /^[a-f0-9]{64}$/i;
const commit = /^[a-f0-9]{40,64}$/i;
if (
  descriptor.schemaVersion !== 'kab.runtime-release.v1' ||
  descriptor.technicalProductId !== 'agent-bridge' ||
  typeof descriptor.packageVersion !== 'string' || !descriptor.packageVersion ||
  typeof descriptor.artifactSha256 !== 'string' || !sha.test(descriptor.artifactSha256) ||
  typeof descriptor.sourceCommit !== 'string' || !commit.test(descriptor.sourceCommit) ||
  (descriptor.channel !== 'stable' && descriptor.channel !== 'candidate')
) process.exit(1);
process.stdout.write(`${descriptor.packageVersion}\n${descriptor.artifactSha256.toLowerCase()}\n${descriptor.sourceCommit.toLowerCase()}\n${descriptor.channel}\n`);
NODE
)
[[ "${#RELEASE_FIELDS[@]}" -eq 4 ]] || fail "Linux release descriptor is invalid."
PACKAGE_VERSION="${RELEASE_FIELDS[0]}"
ARTIFACT_SHA256="${RELEASE_FIELDS[1]}"
SOURCE_COMMIT="${RELEASE_FIELDS[2]}"
CHANNEL="${RELEASE_FIELDS[3]}"

RELEASES_ROOT="$INSTALL_ROOT/releases"
RELEASE_DIR="$RELEASES_ROOT/sha256-$ARTIFACT_SHA256"
CURRENT_LINK="$INSTALL_ROOT/current"

mkdir -p "$RELEASES_ROOT" "$CONFIG_ROOT" "$STATE_ROOT" "$UNIT_DIR"

if [[ "$TEST_MODE" != "1" ]]; then
  [[ "$(id -u)" -eq 0 ]] || fail "Linux service installation requires root privileges."

  if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
    groupadd --system "$SERVICE_GROUP"
  fi
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd \
      --system \
      --gid "$SERVICE_GROUP" \
      --home-dir "$STATE_ROOT" \
      --shell /usr/sbin/nologin \
      "$SERVICE_USER"
  fi
fi

if [[ -e "$RELEASE_DIR" ]]; then
  [[ -f "$RELEASE_DIR/runtime-release.json" ]] || \
    fail "Existing release directory is malformed: $RELEASE_DIR"
  cmp -s "$DESCRIPTOR" "$RELEASE_DIR/runtime-release.json" || \
    fail "Digest-bound release directory already exists with different metadata."
  log "Release already installed: $RELEASE_DIR"
else
  TEMP_RELEASE="$RELEASES_ROOT/.install-sha256-${ARTIFACT_SHA256}-$$"
  [[ ! -e "$TEMP_RELEASE" ]] || fail "Temporary release path already exists."
  mv "$STAGED_ROOT" "$TEMP_RELEASE"
  chmod -R go-w "$TEMP_RELEASE"
  mv "$TEMP_RELEASE" "$RELEASE_DIR"
  log "Installed immutable release: $RELEASE_DIR"
fi

install -m 0644 "$RELEASE_DIR/packaging/linux/agent-bridge.service" \
  "$UNIT_DIR/agent-bridge.service"

if [[ ! -e "$CONFIG_ROOT/agent-bridge.env" ]]; then
  install -m 0600 "$RELEASE_DIR/packaging/linux/agent-bridge.env.example" \
    "$CONFIG_ROOT/agent-bridge.env"
  log "Created initial environment file: $CONFIG_ROOT/agent-bridge.env"
else
  log "Preserved existing environment file: $CONFIG_ROOT/agent-bridge.env"
fi

chmod 0700 "$STATE_ROOT"
if [[ "$TEST_MODE" != "1" ]]; then
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$STATE_ROOT"
fi

if [[ ! -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]; then
  ln -s "$RELEASE_DIR" "$INSTALL_ROOT/.current.new"
  mv -Tf "$INSTALL_ROOT/.current.new" "$CURRENT_LINK"
  log "Initialized current release pointer. Runtime remains stopped until enrollment and explicit enable/start."
fi

if [[ "$TEST_MODE" != "1" ]]; then
  "$SYSTEMCTL_BIN" daemon-reload
fi

printf '%s\n' "packageVersion=$PACKAGE_VERSION"
printf '%s\n' "artifactSha256=$ARTIFACT_SHA256"
printf '%s\n' "sourceCommit=$SOURCE_COMMIT"
printf '%s\n' "channel=$CHANNEL"
printf '%s\n' "releasePath=$RELEASE_DIR"
