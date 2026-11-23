#!/usr/bin/env bash
# Publish dist/obsidian-claude-ghostty-<version>.zip as a GitHub release, with the
# CHANGELOG section for that version as its notes. Uses the REST API through curl
# and node, so the runner needs no gh CLI.
#
# Env: GH_TOKEN, GITHUB_REPOSITORY (owner/repo), TAG (default v<manifest version>).
# DRAFT=true makes a draft release (no tag is created), for testing.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY (owner/repo) is required}"
VERSION=$(node -p 'require("./manifest.json").version')
TAG=${TAG:-v$VERSION}
ZIP="dist/obsidian-claude-ghostty-${VERSION}.zip"
[ -f "$ZIP" ] || { echo "missing $ZIP; run make release-zip" >&2; exit 1; }

notes=$(awk -v v="$VERSION" '$0 ~ "^## \\[?"v"\\]?" {on=1; next} on && /^## / {exit} on' CHANGELOG.md)
[ -n "$notes" ] || notes="obsidianghost $VERSION"

body=$(NOTES="$notes" TAG="$TAG" VERSION="$VERSION" node -e '
  const { NOTES, TAG, VERSION, DRAFT } = process.env;
  console.log(JSON.stringify({
    tag_name: TAG, name: "obsidianghost " + TAG, body: NOTES,
    prerelease: /^0\.|-/.test(VERSION), draft: DRAFT === "true",
  }));')

api="https://api.github.com/repos/$GITHUB_REPOSITORY"
auth=(-H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")
release=$(curl -fsS -X POST "${auth[@]}" "$api/releases" -d "$body")
upload=$(node -e 'console.log(JSON.parse(process.argv[1]).upload_url.replace(/\{.*\}$/, ""))' "$release")
curl -fsS -X POST "${auth[@]}" -H "Content-Type: application/zip" \
  --data-binary @"$ZIP" "$upload?name=$(basename "$ZIP")" >/dev/null
node -e 'const r = JSON.parse(process.argv[1]); console.log(r.id + " " + r.html_url)' "$release"
