#!/usr/bin/env bash
#
# Generate (or refresh) the Homebrew cask for a given Gamut release tag.
#
# This script is the single source of truth for the cask's shape. It is used
# by the release workflow to publish to the tap repo, and can be run locally to
# bootstrap a fresh tap.
#
# Usage:
#   scripts/update-cask.sh <release-tag> [output-cask-path]
#
# Examples:
#   scripts/update-cask.sh alpha-0.3                  # writes ./Casks/gamut.rb
#   scripts/update-cask.sh alpha-0.3 /path/Casks/gamut.rb
#
# Requires the GitHub CLI (`gh`) authenticated against the Gamut repo.
set -euo pipefail

TAG="${1:?usage: update-cask.sh <release-tag> [output-cask-path]}"
OUT="${2:-Casks/gamut.rb}"
REPO="${GAMUT_REPO:-Rymera-Web-Co/Gamut}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# The .dmg filenames embed the app version (from tauri.conf.json), which is
# decoupled from the release tag — e.g. tag `alpha-0.3` ships `Gamut_0.1.0_*`.
arm_asset="$(gh release view "$TAG" --repo "$REPO" --json assets \
  --jq '.assets[].name | select(test("aarch64\\.dmg$"))')"
x64_asset="$(gh release view "$TAG" --repo "$REPO" --json assets \
  --jq '.assets[].name | select(test("_x64\\.dmg$"))')"

if [ -z "$arm_asset" ] || [ -z "$x64_asset" ]; then
  echo "error: could not find both arm64 and x64 .dmg assets on release $TAG" >&2
  exit 1
fi

# Gamut_<version>_aarch64.dmg -> <version>
appver="${arm_asset#Gamut_}"
appver="${appver%_aarch64.dmg}"

gh release download "$TAG" --repo "$REPO" --pattern "$arm_asset" --dir "$tmp"
gh release download "$TAG" --repo "$REPO" --pattern "$x64_asset" --dir "$tmp"

arm_sha="$(shasum -a 256 "$tmp/$arm_asset" | awk '{print $1}')"
x64_sha="$(shasum -a 256 "$tmp/$x64_asset" | awk '{print $1}')"

mkdir -p "$(dirname "$OUT")"

# The unquoted heredoc expands ${...} (our values) but leaves #{...} alone —
# those are Ruby string interpolations evaluated by Homebrew at install time.
cat > "$OUT" <<EOF
cask "gamut" do
  arch arm: "aarch64", intel: "x64"

  # version is "<app-version>,<release-tag>": the .dmg filename uses the app
  # version while the release URL uses the tag, and the two are decoupled.
  version "${appver},${TAG}"
  sha256 arm:   "${arm_sha}",
         intel: "${x64_sha}"

  url "https://github.com/Rymera-Web-Co/Gamut/releases/download/#{version.csv.second}/Gamut_#{version.csv.first}_#{arch}.dmg",
      verified: "github.com/Rymera-Web-Co/Gamut/"
  name "Gamut"
  desc "Local git desktop app for reviewing changes and browsing history"
  homepage "https://github.com/Rymera-Web-Co/Gamut"

  app "Gamut.app"

  zap trash: [
    "~/Library/Application Support/com.rymera.gamut",
    "~/Library/Caches/com.rymera.gamut",
    "~/Library/Saved Application State/com.rymera.gamut.savedState",
    "~/Library/WebKit/com.rymera.gamut",
  ]
end
EOF

echo "Wrote $OUT"
echo "  version: ${appver},${TAG}"
echo "  arm:     ${arm_sha}"
echo "  intel:   ${x64_sha}"
