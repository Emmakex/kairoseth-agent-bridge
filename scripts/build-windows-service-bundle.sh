#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
SOURCE_COMMIT="${2:-}"
RUNTIME_ARTIFACT_SHA256="${3:-}"
OUTPUT_ZIP="${4:-}"
PRODUCTION_NODE_MODULES="${5:-}"
WINSW_EXE="${6:-}"

fail() {
  printf '[windows-bundle] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -n "$VERSION" && -n "$SOURCE_COMMIT" && -n "$RUNTIME_ARTIFACT_SHA256" && -n "$OUTPUT_ZIP" && -n "$PRODUCTION_NODE_MODULES" && -n "$WINSW_EXE" ]] || \
  fail "Usage: build-windows-service-bundle.sh <version> <source-commit> <runtime-artifact-sha256> <output.zip> <production-node-modules> <winsw.exe>"
[[ "$SOURCE_COMMIT" =~ ^[a-fA-F0-9]{40,64}$ ]] || fail "Source commit is invalid."
[[ "$RUNTIME_ARTIFACT_SHA256" =~ ^[a-fA-F0-9]{64}$ ]] || fail "Runtime artifact SHA-256 is invalid."
[[ -d dist/src ]] || fail "dist/src must be built before Windows packaging."
[[ -f package.json && -f package-lock.json ]] || fail "Locked package manifests are required."
[[ -d "$PRODUCTION_NODE_MODULES" ]] || fail "Prebuilt production node_modules directory is required."
[[ -f "$WINSW_EXE" ]] || fail "Pinned WinSW executable is required."
[[ -f packaging/windows/agent-bridge-service.xml.template ]] || fail "Windows service template is missing."
[[ -f packaging/windows/agent-bridge.env.example ]] || fail "Windows environment example is missing."
[[ -f packaging/windows/install-bundle.ps1 ]] || fail "Windows installer is missing."
[[ -f packaging/windows/activate-with-rollback.ps1 ]] || fail "Windows activation script is missing."
[[ -f packaging/windows/WINSW-LICENSE.txt ]] || fail "WinSW license notice is missing."
[[ -f docs/WINDOWS_SERVICE_DEPLOYMENT.md ]] || fail "Windows deployment documentation is missing."

OUTPUT_ZIP="$(realpath -m "$OUTPUT_ZIP")"
PRODUCTION_NODE_MODULES="$(realpath "$PRODUCTION_NODE_MODULES")"
WINSW_EXE="$(realpath "$WINSW_EXE")"
mkdir -p "$(dirname "$OUTPUT_ZIP")"

# Keep Windows packages platform-neutral until a native dependency is deliberately
# introduced with a Windows-specific dependency build. This prevents silently
# shipping Linux-native addons inside a Windows release.
if find "$PRODUCTION_NODE_MODULES" -type f -name '*.node' -print -quit | grep -q .; then
  fail "Production dependency tree contains native .node addons; Windows packaging requires a Windows-specific dependency build."
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

SHORT_SHA="${SOURCE_COMMIT:0:12}"
ROOT_NAME="agent-bridge-${VERSION}-${SHORT_SHA}-windows-x64"
ROOT="$TMP_DIR/$ROOT_NAME"
mkdir -p "$ROOT/dist" "$ROOT/packaging/windows" "$ROOT/docs" "$ROOT/node_modules"

cp -R dist/src "$ROOT/dist/src"
cp package.json package-lock.json README.md "$ROOT/"
cp packaging/windows/agent-bridge-service.xml.template "$ROOT/packaging/windows/"
cp packaging/windows/agent-bridge.env.example "$ROOT/packaging/windows/"
cp packaging/windows/install-bundle.ps1 "$ROOT/packaging/windows/"
cp packaging/windows/activate-with-rollback.ps1 "$ROOT/packaging/windows/"
cp packaging/windows/WINSW-LICENSE.txt "$ROOT/packaging/windows/"
cp "$WINSW_EXE" "$ROOT/packaging/windows/agent-bridge-service.exe"
cp docs/WINDOWS_SERVICE_DEPLOYMENT.md "$ROOT/docs/"
cp -a "$PRODUCTION_NODE_MODULES/." "$ROOT/node_modules/"
rm -rf "$ROOT/node_modules/.bin"

if find "$ROOT/node_modules" -type l -print -quit | grep -q .; then
  fail "Production dependency tree contains symlinks that are unsafe for deterministic Windows ZIP packaging."
fi
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

# ZIP timestamps cannot represent Unix epoch. Normalize every packaged file to
# the earliest portable DOS timestamp and feed zip a sorted file list.
find "$ROOT" -exec touch -t 198001010000 {} +
rm -f "$OUTPUT_ZIP"
(
  cd "$TMP_DIR"
  find "$ROOT_NAME" -type f -print | LC_ALL=C sort | zip -X -q "$OUTPUT_ZIP" -@
)

printf '%s\n' "$OUTPUT_ZIP"
