#!/bin/sh
# Seeds the data volume from the image on every start without overwriting anything the
# harness (or you) already changed, then runs the command. New seed files from an upgraded
# image are added; edited files are kept.
set -eu

seed() {
  src="$1"
  dst="$2"
  [ -d "$src" ] || return 0
  mkdir -p "$dst"
  (cd "$src" && find . -type d) | while IFS= read -r d; do mkdir -p "$dst/$d"; done
  (cd "$src" && find . -type f) | while IFS= read -r f; do
    [ -e "$dst/$f" ] || cp -p "$src/$f" "$dst/$f"
  done
}

mkdir -p "${HARNESS_DATA_DIR:-/app/data}"
if [ -n "${HARNESS_KNOWLEDGE_DIR:-}" ]; then seed /app/knowledge-seed "$HARNESS_KNOWLEDGE_DIR"; fi
if [ -n "${HARNESS_SCRAPERS_DIR:-}" ]; then seed /app/config/scrapers "$HARNESS_SCRAPERS_DIR"; fi
if [ -n "${HARNESS_LEARNED_SKILLS_DIR:-}" ]; then mkdir -p "$HARNESS_LEARNED_SKILLS_DIR"; fi

exec "$@"
