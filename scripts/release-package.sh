#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
EXTENSIONS_DIR="$(cd "${PLUGIN_DIR}/.." && pwd)"

PLUGIN_ID="memory-hybrid-context"
VERSION="$(node -p "require('${PLUGIN_DIR}/package.json').version")"
STAMP="${1:-$(date +%Y%m%d-%H%M%S)}"

RELEASE_DIR="${PLUGIN_DIR}/releases/${VERSION}"
SNAPSHOT_NAME="${PLUGIN_ID}-${VERSION}-${STAMP}.bundle.tar.gz"
SNAPSHOT_PATH="${RELEASE_DIR}/${SNAPSHOT_NAME}"
SNAPSHOT_SHA_PATH="${SNAPSHOT_PATH}.sha256"
SNAPSHOT_MANIFEST_PATH="${RELEASE_DIR}/${PLUGIN_ID}-${VERSION}-${STAMP}.manifest.json"

LATEST_PATH="${EXTENSIONS_DIR}/${PLUGIN_ID}-latest.bundle.tar.gz"
LATEST_SHA_PATH="${LATEST_PATH}.sha256"
LATEST_MANIFEST_PATH="${EXTENSIONS_DIR}/${PLUGIN_ID}-latest.json"

mkdir -p "${RELEASE_DIR}"

(
  cd "${EXTENSIONS_DIR}"
  tar \
    --exclude="./${PLUGIN_ID}/releases" \
    --exclude="./${PLUGIN_ID}/.git" \
    --exclude="./${PLUGIN_ID}/.git/*" \
    -czf "${SNAPSHOT_PATH}" \
    "./${PLUGIN_ID}"
)

sha256sum "${SNAPSHOT_PATH}" > "${SNAPSHOT_SHA_PATH}"
cp "${SNAPSHOT_PATH}" "${LATEST_PATH}"
sha256sum "${LATEST_PATH}" > "${LATEST_SHA_PATH}"

cat > "${SNAPSHOT_MANIFEST_PATH}" <<EOF
{
  "pluginId": "${PLUGIN_ID}",
  "version": "${VERSION}",
  "createdAt": "${STAMP}",
  "type": "snapshot",
  "bundle": "releases/${VERSION}/${SNAPSHOT_NAME}",
  "checksum": "releases/${VERSION}/${SNAPSHOT_NAME}.sha256"
}
EOF

cat > "${LATEST_MANIFEST_PATH}" <<EOF
{
  "pluginId": "${PLUGIN_ID}",
  "version": "${VERSION}",
  "updatedAt": "${STAMP}",
  "type": "latest",
  "bundle": "${PLUGIN_ID}-latest.bundle.tar.gz",
  "checksum": "${PLUGIN_ID}-latest.bundle.tar.gz.sha256",
  "sourceSnapshot": "memory-hybrid-context/releases/${VERSION}/${SNAPSHOT_NAME}"
}
EOF

echo "snapshot=${SNAPSHOT_PATH}"
echo "snapshot_sha=${SNAPSHOT_SHA_PATH}"
echo "snapshot_manifest=${SNAPSHOT_MANIFEST_PATH}"
echo "latest=${LATEST_PATH}"
echo "latest_sha=${LATEST_SHA_PATH}"
echo "latest_manifest=${LATEST_MANIFEST_PATH}"
