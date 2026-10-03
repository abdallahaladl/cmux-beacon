#!/bin/sh
out=""
for arg in "$@"; do out="$out$arg"$'\037'; done
printf '%s\n' "$out" >> "$CAPTURE_LOG"
