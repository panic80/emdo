#!/bin/sh
set -eu

manifest=/usr/local/share/emdo/finance-ocr-runtime.json
checksums=/usr/local/share/emdo/finance-ocr-runtime.sha256
policy_checksum=/usr/local/share/emdo/finance-ocr-policy.sha256

test -s "$manifest"
test -s "$checksums"
test -s "$policy_checksum"
sha256sum --strict -c "$checksums"
sha256sum --strict -c "$policy_checksum"

test -x /usr/local/bin/magick
test -x /usr/bin/tesseract
test -f /usr/share/tesseract-ocr/5/tessdata/eng.traineddata
test -f /usr/share/tesseract-ocr/5/tessdata/fra.traineddata

version="$(tesseract --version 2>/dev/null | sed -n '1s/^tesseract //p')"
test "$version" = "5.3.0"

langs="$(tesseract --list-langs 2>/dev/null)"
printf '%s\n' "$langs" | grep -Fx 'eng' >/dev/null
printf '%s\n' "$langs" | grep -Fx 'fra' >/dev/null

# This traverses the same wrapper and policy used by the adapter, without
# reading a file path or contacting a delegate.
result="$(printf 'P2\n1 1\n255\n0\n' | /usr/local/bin/magick identify -format '%m %w %h %n\n' pgm:-)"
test "$result" = "PGM 1 1 1"

# The runtime must reject a delegate-only format even when bytes arrive on
# stdin. This guards the policy against a permissive base-image configuration.
if printf '%s' '%PDF-1.4' | /usr/local/bin/magick identify pdf:- >/dev/null 2>&1; then
  echo 'finance OCR policy unexpectedly accepted PDF' >&2
  exit 1
fi
