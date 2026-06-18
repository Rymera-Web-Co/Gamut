#!/usr/bin/env bash
#
# Stamp a rolling nightly version into tauri.conf.json and package.json.
#
# Used by .github/workflows/nightly.yml right before the tauri-action build so
# nightly artifacts carry a distinct, date-stamped version. This script is the
# single source of truth for the nightly version scheme.
#
# Usage:
#   scripts/set-nightly-version.sh [YYYYMMDD]
#
# Examples:
#   scripts/set-nightly-version.sh            # uses UTC today
#   scripts/set-nightly-version.sh 20260618   # pins the date
#
# Version scheme — why `<base patch+1>-nightly.<YYYYMMDD>`:
#
#   Base version (from tauri.conf.json) is the current STABLE version, e.g.
#   0.4.0. We want every nightly to semver-order ABOVE that stable release and
#   to be monotonic per day, so the updater always treats a nightly as "newer".
#
#   A prerelease sorts BEFORE its own release in semver:
#       0.4.0-nightly.20260618  <  0.4.0
#   So naively tagging the nightly as `0.4.0-nightly.X` would make every
#   nightly sort BELOW the shipped 0.4.0 — exactly backwards.
#
#   To fix the ordering we bump the PATCH first, then attach the prerelease:
#       base 0.4.0  ->  0.4.1-nightly.<YYYYMMDD>
#   Now:
#       0.4.0                  <  0.4.1-nightly.20260618   (nightly > stable)
#       0.4.1-nightly.20260618 <  0.4.1-nightly.20260619   (monotonic per day)
#       0.4.1-nightly.<date>   <  0.4.1                    (future stable wins)
#   This keeps nightlies strictly between the current stable and the next
#   stable patch, sorted by date — which is what we want.
#
# Requires node (available in CI) for robust JSON read/write.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_CONF="$ROOT/src-tauri/tauri.conf.json"
PKG_JSON="$ROOT/package.json"

DATE="${1:-$(date -u +'%Y%m%d')}"

if ! [[ "$DATE" =~ ^[0-9]{8}$ ]]; then
  echo "error: date must be in YYYYMMDD form, got '$DATE'" >&2
  exit 1
fi

# Read the current (stable) base version from tauri.conf.json.
BASE="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$TAURI_CONF")"

if ! [[ "$BASE" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "error: base version '$BASE' is not a clean MAJOR.MINOR.PATCH" >&2
  exit 1
fi

MAJOR="${BASH_REMATCH[1]}"
MINOR="${BASH_REMATCH[2]}"
PATCH="${BASH_REMATCH[3]}"

# Bump patch, then attach the date-stamped prerelease (see header rationale).
NIGHTLY="${MAJOR}.${MINOR}.$((PATCH + 1))-nightly.${DATE}"

# Rewrite both files in place, preserving 2-space indentation + trailing newline.
write_version() {
  node -e '
    const fs = require("fs");
    const [file, version] = [process.argv[1], process.argv[2]];
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    json.version = version;
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  ' "$1" "$NIGHTLY"
}

write_version "$TAURI_CONF"
write_version "$PKG_JSON"

echo "Set nightly version: $NIGHTLY (base $BASE)"
echo "  $TAURI_CONF"
echo "  $PKG_JSON"
