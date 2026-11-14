#!/usr/bin/env bash
# Publishes the committed source to GitHub as one snapshot commit, without this Mac's history.
#
#   scripts/publish-source.sh "<what this snapshot is>" [tag]
#
# The working history (branch main, here) carries the owner's commit email and, in old commits,
# files that named this Mac's home folder. Neither is published. Instead the tree of HEAD is
# committed onto the local branch `public` (a line of snapshots, one per publication) under the
# account's GitHub no-reply address, and that branch is pushed as the repository's main. With a tag
# name, the tag is put on the snapshot and pushed too.
#
# It refuses a dirty tree, and a tree in which any tracked file names the home folder or the
# commit email: scrub first (golden/ is recorded with /Users/nobody; see make-golden-runs.sh).
set -euo pipefail
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ "$#" -ge 1 ] || die 'usage: scripts/publish-source.sh "<what this snapshot is>" [tag]'
MESSAGE="$1"; TAG="${2:-}"
[ -z "$(git status --porcelain)" ] || die "commit first: the tree is not clean"
git remote get-url origin >/dev/null 2>&1 || die "no remote named origin"

email="$(git config user.email || true)"
escaped_home="${HOME//\//\\/}"
leaks="$(git grep -l -a -F -e "$HOME" -e "$escaped_home" ${email:+-e "$email"} HEAD -- . 2>/dev/null | sed 's/^HEAD://' || true)"
[ -z "$leaks" ] || { printf '%s\n' "$leaks" | head -20 >&2; die "the files above name this Mac's home folder or the commit email"; }

login="$(gh api user -q .login)"; id="$(gh api user -q .id)"
[ -n "$login" ] && [ -n "$id" ] || die "gh is not signed in"
export GIT_AUTHOR_NAME="$login" GIT_AUTHOR_EMAIL="$id+$login@users.noreply.github.com"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

tree="$(git rev-parse 'HEAD^{tree}')"
if parent="$(git rev-parse -q --verify refs/heads/public)"; then
    [ "$(git rev-parse "$parent^{tree}")" != "$tree" ] || die "nothing new: public already holds this tree"
    commit="$(git commit-tree "$tree" -p "$parent" -m "$MESSAGE")"
else
    commit="$(git commit-tree "$tree" -m "$MESSAGE")"
fi
git update-ref refs/heads/public "$commit"
git push --force origin "refs/heads/public:refs/heads/main"
if [ -n "$TAG" ]; then
    git tag -f -a "$TAG" "$commit" -m "$MESSAGE" >/dev/null
    git push --force origin "refs/tags/$TAG"
fi
printf 'Published %s as %s (tree of %s)%s\n' "$MESSAGE" "$(git rev-parse --short "$commit")" "$(git rev-parse --short HEAD)" "${TAG:+, tagged $TAG}"
