#!/bin/bash
# Open Brain — deploy, version & push to GitHub
# Usage:
#   bash deploy.sh                  — deploy all, auto-patch bump (1.0.0 → 1.0.1)
#   bash deploy.sh open-brain-mcp   — deploy one function, auto-patch bump
#   bash deploy.sh --minor          — deploy all, minor bump (1.0.1 → 1.1.0)
#   bash deploy.sh --major          — deploy all, major bump (1.1.0 → 2.0.0)
#   bash deploy.sh --no-bump        — deploy all, no version change

set -e

VERSION_FILE="VERSION"

# ─── Read current version ───────────────────────────────────
if [ ! -f "$VERSION_FILE" ]; then
  echo "1.0.0" > "$VERSION_FILE"
fi
CURRENT=$(cat "$VERSION_FILE" | tr -d '[:space:]')
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

# ─── Parse args ─────────────────────────────────────────────
BUMP="patch"
FUNC=""
for arg in "$@"; do
  case "$arg" in
    --major)    BUMP="major" ;;
    --minor)    BUMP="minor" ;;
    --no-bump)  BUMP="none"  ;;
    *)          FUNC="$arg"  ;;
  esac
done

# ─── Bump version ───────────────────────────────────────────
case "$BUMP" in
  major)  MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor)  MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch)  PATCH=$((PATCH + 1)) ;;
  none)   ;; # keep as is
esac
NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"

echo "╔════════════════════════════════════════╗"
echo "║  Open Brain Deploy                     ║"
echo "║  $CURRENT → v$NEW_VERSION                      ║"
echo "╚════════════════════════════════════════╝"
echo ""

# ─── Deploy to Supabase ────────────────────────────────────
if [ -n "$FUNC" ]; then
  echo "🚀 Deploying $FUNC..."
  supabase functions deploy "$FUNC" --no-verify-jwt
else
  echo "🚀 Deploying all functions..."
  for func in open-brain-mcp ingest-thought ingest-thought-telegram; do
    if [ -d "supabase/functions/$func" ]; then
      echo "  → $func"
      supabase functions deploy "$func" --no-verify-jwt
    fi
  done
fi

# ─── Save version ──────────────────────────────────────────
echo "$NEW_VERSION" > "$VERSION_FILE"

# ─── Git: commit, tag & push ───────────────────────────────
echo ""
echo "📝 Committing & tagging v$NEW_VERSION..."
git add -A

if git diff --cached --quiet; then
  echo "No changes to commit."
else
  TIMESTAMP=$(date +"%Y-%m-%d %H:%M")

  if [ -n "$FUNC" ]; then
    MSG="v$NEW_VERSION — deploy $FUNC ($TIMESTAMP)"
  else
    MSG="v$NEW_VERSION — deploy all ($TIMESTAMP)"
  fi

  git commit -m "$MSG"
  git tag -a "v$NEW_VERSION" -m "$MSG"
  git push
  git push --tags
  echo "✅ Pushed v$NEW_VERSION to GitHub with tag!"
fi

echo ""
echo "📋 Recent versions:"
git tag --sort=-v:refname | head -5

echo ""
echo "Done! Current version: v$NEW_VERSION"
