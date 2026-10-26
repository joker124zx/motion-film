#!/bin/sh
# publish.sh — fill in your GitHub owner/repo, commit, and push this skill pack.
#   sh publish.sh <owner>/<repo> [--private] [--dry-run]
# With the GitHub CLI (gh) logged in, it creates the repo for you. Without gh, create an EMPTY repo
# on github.com first (no README / license), then run this.
# Run it once; afterwards it is safe to delete this file.
set -e
[ -n "$1" ] || { echo "usage: sh publish.sh <owner>/<repo> [--private] [--dry-run]"; exit 2; }
SLUG=$1; OWNER=${SLUG%%/*}; REPO=${SLUG#*/}
[ "$OWNER" != "$SLUG" ] && [ -n "$REPO" ] || { echo "✗ give it as owner/repo, e.g. alice/motion-film"; exit 2; }
VIS=--public; DRY=0
for a in "$@"; do case "$a" in --private) VIS=--private;; --dry-run) DRY=1;; esac; done
cd "$(dirname "$0")"
command -v git >/dev/null || { echo "✗ git is needed"; exit 1; }

# 1. placeholders → your owner/repo
for f in README.md LICENSE .claude-plugin/marketplace.json plugins/motion-film/.claude-plugin/plugin.json; do
  perl -pi -e "s/__OWNER__/$OWNER/g; s/__REPO__/$REPO/g" "$f"
done
if grep -rq '__OWNER__\|__REPO__' README.md LICENSE .claude-plugin plugins; then echo "✗ placeholders left"; exit 1; fi
echo "✓ filled in $OWNER/$REPO"

# 2. commit
[ -d .git ] || git init -q -b main
git add -A
git -c core.hooksPath=/dev/null commit -q -m "motion-film: skill pack for making videos in code

Directing, timing, aesthetic rules, product-promo route, style atlas, sound,
beat sync and review guides, plus a deterministic render(t) toolchain
(render.mjs, motion.js, sfx.py, master.sh, beat_grid.py, capture.mjs)
and a runnable starter project.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EUSty2AA1LtEN3ZPsa7Mq1" || echo "  (nothing new to commit)"
git branch -M main
[ "$DRY" = 1 ] && { echo "dry run: stopping before push"; exit 0; }

# 3. push
DESC="用代码做动态影像的 Claude Code 技能包：产品宣传片、MG/风格短片、花字、卡点片 · Make videos in code"
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1 && ! gh repo view "$SLUG" >/dev/null 2>&1; then
  gh repo create "$SLUG" $VIS --description "$DESC" --source . --remote origin --push
  gh repo edit "$SLUG" --add-topic claude-code --add-topic claude-skills --add-topic motion-graphics --add-topic video >/dev/null 2>&1 || true
else
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$SLUG.git"
  git push -u origin main
fi
echo "✓ https://github.com/$SLUG"
echo "  install:  claude plugin marketplace add $SLUG && claude plugin install motion-film@motion-film"
