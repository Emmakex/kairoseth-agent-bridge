#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
SOURCE_COMMIT="${2:-}"
RUNTIME_ARTIFACT_SHA256="${3:-}"
OUTPUT_ARCHIVE="${4:-}"

fail() {
  printf '[linux-bundle] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -n "$VERSION" && -n "$SOURCE_COMMIT" && -n "$RUNTIME_ARTIFACT_SHA256" && -n "$OUTPUT_ARCHIVE" ]] || \
  fail "Usage: build-linux-service-bundle.sh <version> <source-commit> <runtime-artifact-sha256> <output.tar.gz>"
[[ "$SOURCE_COMMIT" =~ ^[a-fA-F0-9]{40,64}$ ]] || fail "Source commit is invalid."
[[ "$RUNTIME_ARTIFACT_SHA256" =~ ^[a-fA-F0-9]{64}$ ]] || fail "Runtime artifact SHA-256 is invalid."
[[ -d dist/src ]] || fail "dist/src must be built before Linux packaging."
[[ -f package.json && -f package-lock.json ]] || fail "Locked package manifests are required."
[[ -f packaging/linux/agent-bridge.service ]] || fail "systemd unit is missing."
[[ -f docs/LINUX_SERVICE_DEPLOYMENT.md ]] || fail "Linux deployment documentation is missing."
command -v docker >/dev/null 2>&1 || fail "Docker is required to build the Linux production dependency tree."

OUTPUT_ARCHIVE="$(realpath -m "$OUTPUT_ARCHIVE")"
mkdir -p "$(dirname "$OUTPUT_ARCHIVE")"

TMP_DIR="$(mktemp -d)"
DEPS_IMAGE="agent-bridge-linux-deps:${SOURCE_COMMIT:0:12}-$$"
DEPS_CONTAINER=""
cleanup() {
  if [[ -n "$DEPS_CONTAINER" ]]; then
    docker rm -f "$DEPS_CONTAINER" >/dev/null 2>&1 || true
  fi
  docker image rm -f "$DEPS_IMAGE" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

SHORT_SHA="${SOURCE_COMMIT:0:12}"
ROOT_NAME="agent-bridge-${VERSION}-${SHORT_SHA}-linux-x64"
ROOT="$TMP_DIR/$ROOT_NAME"
mkdir -p "$ROOT/dist" "$ROOT/packaging/linux" "$ROOT/docs"

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

# Build the production dependency tree in the same pinned Node 22 Linux image
# used by the release Docker artifact. This deliberately avoids a second npm
# resolution/prune pass against the mutable host node_modules tree.
DEPS_CONTEXT="$TMP_DIR/deps-context"
mkdir -p "$DEPS_CONTEXT"
cp package.json package-lock.json "$DEPS_CONTEXT/"
cat > "$DEPS_CONTEXT/Dockerfile" <<'DOCKERFILE'
FROM node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && npm cache clean --force
DOCKERFILE

printf '[linux-bundle] Building locked production dependencies in pinned Node image...\n' >&2
docker build \
  --file "$DEPS_CONTEXT/Dockerfile" \
  --tag "$DEPS_IMAGE" \
  "$DEPS_CONTEXT" >/dev/null
DEPS_CONTAINER="$(docker create "$DEPS_IMAGE")"
docker cp "$DEPS_CONTAINER:/app/node_modules" "$ROOT/node_modules"
docker rm "$DEPS_CONTAINER" >/dev/null
DEPS_CONTAINER=""
docker image rm "$DEPS_IMAGE" >/dev/null 2>&1 || true

[[ -d "$ROOT/node_modules/@modelcontextprotocol/server" ]] || \
  fail "Production dependency @modelcontextprotocol/server is missing from containerized install."
[[ -d "$ROOT/node_modules/mysql2" ]] || \
  fail "Production dependency mysql2 is missing from containerized install."
[[ ! -d "$ROOT/node_modules/typescript" ]] || \
  fail "Development dependency typescript leaked into the production bundle."

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
