#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
SOURCE_COMMIT="${2:-}"
RUNTIME_ARTIFACT_SHA256="${3:-}"
OUTPUT_ARCHIVE="${4:-}"
PRODUCTION_NODE_MODULES="${5:-}"

fail() {
  printf '[linux-bundle] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -n "$VERSION" && -n "$SOURCE_COMMIT" && -n "$RUNTIME_ARTIFACT_SHA256" && -n "$OUTPUT_ARCHIVE" && -n "$PRODUCTION_NODE_MODULES" ]] || \
  fail "Usage: build-linux-service-bundle.sh <version> <source-commit> <runtime-artifact-sha256> <output.tar.gz> <production-node-modules>"
[[ "$SOURCE_COMMIT" =~ ^[a-fA-F0-9]{40,64}$ ]] || fail "Source commit is invalid."
[[ "$RUNTIME_ARTIFACT_SHA256" =~ ^[a-fA-F0-9]{64}$ ]] || fail "Runtime artifact SHA-256 is invalid."
[[ -d dist/src ]] || fail "dist/src must be built before Linux packaging."
[[ -f package.json && -f package-lock.json ]] || fail "Locked package manifests are required."
[[ -d "$PRODUCTION_NODE_MODULES" ]] || fail "Prebuilt production node_modules directory is required."
[[ -f packaging/linux/agent-bridge.service ]] || fail "systemd unit is missing."
[[ -f docs/LINUX_SERVICE_DEPLOYMENT.md ]] || fail "Linux deployment documentation is missing."

OUTPUT_ARCHIVE="$(realpath -m "$OUTPUT_ARCHIVE")"
PRODUCTION_NODE_MODULES="$(realpath "$PRODUCTION_NODE_MODULES")"
mkdir -p "$(dirname "$OUTPUT_ARCHIVE")"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

SHORT_SHA="${SOURCE_COMMIT:0:12}"
ROOT_NAME="agent-bridge-${VERSION}-${SHORT_SHA}-linux-x64"
ROOT="$TMP_DIR/$ROOT_NAME"
mkdir -p "$ROOT/dist" "$ROOT/packaging/linux" "$ROOT/docs" "$ROOT/node_modules"

cp -R dist/src "$ROOT/dist/src"
cp package.json package-lock.json README.md "$ROOT/"
cp packaging/linux/agent-bridge.service "$ROOT/packaging/linux/"
cp packaging/linux/agent-bridge.env.example "$ROOT/packaging/linux/"
cp packaging/linux/install-bundle.sh "$ROOT/packaging/linux/"
cp packaging/linux/activate-with-rollback.sh "$ROOT/packaging/linux/"
cp docs/LINUX_SERVICE_DEPLOYMENT.md "$ROOT/docs/"
chmod 0755 \
  "$ROOT/packaging/linux/install-bundle.sh" \
  "$ROOT/packaging/linux/activate-with-rollback.sh"

# The dependency tree is produced by the already-validated release image build.
# This script is intentionally a pure assembler: it never resolves, installs or
# prunes npm dependencies on the packaging host.
cp -a "$PRODUCTION_NODE_MODULES/." "$ROOT/node_modules/"

[[ -d "$ROOT/node_modules/@modelcontextprotocol/server" ]] || \
  fail "Production dependency @modelcontextprotocol/server is missing from the prebuilt dependency tree."
[[ -d "$ROOT/node_modules/mysql2" ]] || \
  fail "Production dependency mysql2 is missing from the prebuilt dependency tree."
[[ ! -d "$ROOT/node_modules/typescript" ]] || \
  fail "Development dependency typescript leaked into the production dependency tree."

CHANNEL="stable"
if [[ "$VERSION" == *-* ]]; then
  CHANNEL="candidate"
fi

cat > "$ROOT/runtime-release.json" <<JSON
{
  "schemaVersion": "kab.runtime-release.v1",
  "technicalProductId": "agent-bridge",
  "packageVersion": "$VERSION",
  "artifactSha256": "${RUNTIME_ARTIFACT_SHA256,,}",
  "sourceCommit": "${SOURCE_COMMIT,,}",
  "channel": "$CHANNEL"
}
JSON

# Ensure packaged files are immutable-by-default; state/config live elsewhere.
chmod -R a-w "$ROOT"

tar \
  --sort=name \
  --mtime='UTC 1970-01-01' \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  -C "$TMP_DIR" \
  -cf - "$ROOT_NAME" | gzip -n > "$OUTPUT_ARCHIVE"

printf '%s\n' "$OUTPUT_ARCHIVE"
