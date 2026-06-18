#!/usr/bin/env bash
#
# Publish the Homebrew cask for a released Gamut tag to the tap repo.
#
# This is the maintainer-run replacement for the old `publish-cask` CI job. It
# runs entirely on your machine over your existing git/`gh` auth, so the release
# pipeline needs no cross-repo push token (no HOMEBREW_TAP_TOKEN secret).
#
# It renders the cask with update-cask.sh (the single source of truth for the
# cask's shape), then clones the tap, copies the cask in, and pushes — but only
# if something actually changed.
#
# Prerequisites:
#   - `gh` authenticated against the Gamut repo (update-cask.sh uses it to read
#     the release assets), and
#   - push access to Rymera-Web-Co/homebrew-gamut from this machine (SSH key or
#     `gh` credential helper).
#
# Usage:
#   scripts/publish-cask.sh <release-tag>
#
# Example:
#   scripts/publish-cask.sh alpha-0.4
set -euo pipefail

TAG="${1:?usage: publish-cask.sh <release-tag>}"
TAP_REPO="${GAMUT_TAP_REPO:-git@github.com:Rymera-Web-Co/homebrew-gamut.git}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

tap_dir="$(mktemp -d)"
trap 'rm -rf "$tap_dir"' EXIT

echo "Cloning tap $TAP_REPO ..."
git clone --quiet "$TAP_REPO" "$tap_dir"

echo "Rendering cask for $TAG ..."
"$here/update-cask.sh" "$TAG" "$tap_dir/Casks/gamut.rb"

cd "$tap_dir"
# Stage first, then compare the staged tree against HEAD. A plain `git diff`
# ignores untracked files, so on the very first publish (cask not yet tracked)
# it would report "nothing to push" and skip the commit.
git add Casks/gamut.rb
if git diff --quiet --cached; then
  echo "Cask already up to date for $TAG — nothing to push."
  exit 0
fi

git commit --quiet -m "gamut $TAG"
git push
echo "Published cask for $TAG to $TAP_REPO"
