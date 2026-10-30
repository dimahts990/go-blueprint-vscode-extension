#!/bin/sh
# Bump the version and create a release commit. GitHub Actions releases on push to main.
set -eu

usage() {
  cat <<'USAGE'
Usage: ./scripts/release.sh [patch|minor|major] [--push]

Bumps package.json and package-lock.json and creates a release commit on main.
Default: patch. Pass --push to push main and start the GitHub release workflow.
USAGE
}

bump=patch
push=false
bump_set=false
for arg in "$@"; do
  case "$arg" in
    patch|minor|major)
      if [ "$bump_set" = true ]; then
        echo 'Specify only one version increment.' >&2
        usage >&2
        exit 2
      fi
      bump=$arg
      bump_set=true
      ;;
    --push) push=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

branch=$(git branch --show-current)
if [ "$branch" != main ]; then
  echo "Release commits must be made on main (current branch: ${branch:-detached HEAD})." >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo 'Commit or stash all changes before creating a release commit.' >&2
  exit 1
fi

version=$(npm version "$bump" --no-git-tag-version)
git add -- package.json package-lock.json
git commit -m "chore: release $version"

if [ "$push" = true ]; then
  git push origin main
  echo "Pushed $version. GitHub Actions will build the VSIX and create the release."
else
  echo "Created release commit for $version. Run 'git push origin main' to start the release."
fi
