#!/bin/sh
set -eu

# A single-request, stdin/stdout-only boundary for the native OCR runtime.
# The worker sends a fixed header followed by source bytes and (for the OCR
# stage) a bounded PGM payload. No caller-supplied command, path, URL, or
# ImageMagick delegate is accepted here.

readonly PROTOCOL_REQUEST='EMDO-FINANCE-OCR-HELPER-V1'
readonly PROTOCOL_RESPONSE='EMDO-FINANCE-OCR-HELPER-V1-RESPONSE'
readonly MANIFEST='/usr/local/share/emdo/finance-ocr-runtime.json'
readonly HEALTHCHECK='/usr/local/bin/emdo-finance-ocr-runtime-healthcheck'
readonly MAGICK='/usr/local/bin/magick'
readonly TESSERACT='/usr/bin/tesseract'
readonly SHA256SUM='/usr/bin/sha256sum'
readonly TESSDATA='/usr/share/tesseract-ocr/5/tessdata'
readonly HARD_MAX_BYTES=2097152
readonly HARD_MAX_PIXELS=40000000
readonly HARD_MAX_DIMENSION=100000
readonly HARD_MAX_WORDS=20000
readonly HARD_MAX_TEXT_CHARACTERS=262144
readonly HARD_MAX_DECODED_BYTES=50331648
readonly HARD_MAX_OUTPUT_BYTES=2097152
readonly HARD_MAX_TIMEOUT_MS=15000

fail() {
  exit 74
}

read_header() {
  expected_key=$1
  IFS= read -r header_value || fail
  [ "${#header_value}" -le 1024 ] || fail
  case "$header_value" in
    "$expected_key="*) printf '%s' "${header_value#"$expected_key="}" ;;
    *) fail ;;
  esac
}

is_uint() {
  case "$1" in
    0|[1-9][0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

check_uint_limit() {
  is_uint "$1" || fail
  [ "$1" -le "$2" ] || fail
}

check_positive_limit() {
  check_uint_limit "$1" "$2"
  [ "$1" -gt 0 ] || fail
}

check_sha256() {
  value=$1
  [ "${#value}" -eq 64 ] || fail
  case "$value" in
    *[!0123456789abcdef]*) fail ;;
  esac
}

read_exact() {
  count=$1
  target=$2
  if [ "$count" -eq 0 ]; then
    : > "$target"
    return
  fi
  /usr/bin/head -c "$count" > "$target" || fail
  actual_size=$(/usr/bin/wc -c < "$target" | /usr/bin/tr -d '[:space:]')
  [ "$actual_size" = "$count" ] || fail
}

run_bounded() {
  timeout_ms=$1
  shift
  # GNU timeout accepts fractional seconds, not an ms suffix.
  timeout_seconds=$(printf '%s.%03d' "$((timeout_ms / 1000))" "$((timeout_ms % 1000))")
  /usr/bin/timeout --signal=KILL --kill-after=1s "${timeout_seconds}s" "$@"
}

run_bounded_to_file() {
  output_limit=$1
  timeout_ms=$2
  target=$3
  shift 3
  (
    # ulimit uses 512-byte blocks. The byte-length check below remains the
    # authoritative exact bound; this keeps a noisy native process from
    # filling the helper's scratch filesystem before that check runs.
    output_blocks=$(( (output_limit + 511) / 512 ))
    ulimit -f "$output_blocks" || exit 74
    run_bounded "$timeout_ms" "$@"
  ) > "$target"
}

format_args() {
  case "$1" in
    png|jpeg|webp) printf '%s:-' "$1" ;;
    *) fail ;;
  esac
}

mkdir_workdir() {
  /usr/bin/mktemp -d /tmp/emdo-finance-ocr.XXXXXX
}

umask 077
workdir=$(mkdir_workdir) || fail
trap 'rm -rf "$workdir"' EXIT HUP INT TERM

IFS= read -r protocol || fail
[ "$protocol" = "$PROTOCOL_REQUEST" ] || fail

operation=$(read_header operation)
format=$(read_header format)
language=$(read_header language)
source_check=$(read_header source-check)
source_digest=$(read_header source-sha256)
source_length=$(read_header source-length)
payload_length=$(read_header payload-length)
max_bytes=$(read_header max-bytes)
max_pixels=$(read_header max-pixels)
max_dimension=$(read_header max-dimension)
max_words=$(read_header max-words)
max_text_characters=$(read_header max-text-characters)
max_decoded_bytes=$(read_header max-decoded-bytes)
max_output_bytes=$(read_header max-output-bytes)
timeout_ms=$(read_header timeout-ms)
IFS= read -r blank || fail
[ -z "$blank" ] || fail

case "$operation" in
  verify|identify|decode|describe|recognize) ;;
  *) fail ;;
esac
case "$format" in
  png|jpeg|webp) ;;
  *) fail ;;
esac
case "$language" in
  eng|fra|eng+fra) ;;
  *) fail ;;
esac
case "$source_check" in
  required|none) ;;
  *) fail ;;
esac
case "$operation" in
  identify|decode|recognize) [ "$source_check" = 'required' ] || fail ;;
  verify|describe) [ "$source_check" = 'none' ] || fail ;;
esac
check_sha256 "$source_digest"
check_uint_limit "$source_length" "$HARD_MAX_BYTES"
check_positive_limit "$max_bytes" "$HARD_MAX_BYTES"
check_positive_limit "$max_pixels" "$HARD_MAX_PIXELS"
check_positive_limit "$max_dimension" "$HARD_MAX_DIMENSION"
check_positive_limit "$max_words" "$HARD_MAX_WORDS"
check_positive_limit "$max_text_characters" "$HARD_MAX_TEXT_CHARACTERS"
check_positive_limit "$max_decoded_bytes" "$HARD_MAX_DECODED_BYTES"
check_positive_limit "$max_output_bytes" "$HARD_MAX_OUTPUT_BYTES"
check_positive_limit "$timeout_ms" "$HARD_MAX_TIMEOUT_MS"

case "$source_check" in
  required)
    [ "$source_length" -gt 0 ] || fail
    [ "$source_length" -le "$max_bytes" ] || fail
    ;;
  none)
    [ "$source_length" -eq 0 ] || fail
    ;;
esac
if [ "$operation" = 'recognize' ]; then
  check_uint_limit "$payload_length" "$max_decoded_bytes"
else
  [ "$payload_length" -eq 0 ] || fail
fi

source_file="$workdir/source.bin"
payload_file="$workdir/payload.bin"
result_file="$workdir/result.bin"
pgm_file="$workdir/decoded.pgm"
version_file="$workdir/tesseract-version.txt"
languages_file="$workdir/tesseract-languages.txt"
read_exact "$source_length" "$source_file"
read_exact "$payload_length" "$payload_file"

if [ "$source_check" = 'required' ]; then
  actual_digest=$($SHA256SUM "$source_file" | /usr/bin/awk '{print $1}')
  [ "$actual_digest" = "$source_digest" ] || fail
fi

# The healthcheck verifies the immutable executable, traineddata and policy
# hashes from the release manifest before any source bytes reach a native
# decoder. Its diagnostics stay inside the helper and never cross stdout.
"$HEALTHCHECK" >/dev/null 2>&1 || fail

: > "$result_file"
: > "$pgm_file"
input_format=$(format_args "$format")

case "$operation" in
  verify)
    ;;
  identify)
    run_bounded_to_file "$max_output_bytes" "$timeout_ms" "$result_file" \
      "$MAGICK" identify -ping \
      -limit thread 1 \
      -limit area "$max_pixels" \
      -limit width "$max_dimension" \
      -limit height "$max_dimension" \
      -limit memory "$max_decoded_bytes" \
      -limit map "$max_decoded_bytes" \
      -limit disk 0 \
      -format '%m %w %h %[orientation] %n\n' "$input_format" \
      < "$source_file" || fail
    ;;
  decode)
    run_bounded_to_file "$max_decoded_bytes" "$timeout_ms" "$pgm_file" \
      "$MAGICK" \
      -limit thread 1 \
      -limit area "$max_pixels" \
      -limit width "$max_dimension" \
      -limit height "$max_dimension" \
      -limit memory "$max_decoded_bytes" \
      -limit map "$max_decoded_bytes" \
      -limit disk 0 \
      "$input_format" \
      -background white \
      -alpha remove \
      -colorspace Gray \
      -define pgm:format=bin \
      -depth 8 \
      PGM:- < "$source_file" || fail
    decoded_size=$(/usr/bin/wc -c < "$pgm_file" | /usr/bin/tr -d '[:space:]')
    [ "$decoded_size" -gt 0 ] || fail
    [ "$decoded_size" -le "$max_decoded_bytes" ] || fail
    ;;
  describe)
    run_bounded_to_file "$max_output_bytes" "$timeout_ms" "$version_file" \
      "$TESSERACT" --version 2>&1 || fail
    version=$(/usr/bin/sed -n '1s/^tesseract //p' "$version_file")
    [ -n "$version" ] || fail
    case "$version" in
      *[!A-Za-z0-9._+-]*) fail ;;
    esac
    run_bounded "$timeout_ms" "$TESSERACT" --tessdata-dir "$TESSDATA" \
      --list-langs > "$languages_file" 2>/dev/null || fail
    case "$language" in
      eng) /usr/bin/grep -Fx eng "$languages_file" >/dev/null || fail ;;
      fra) /usr/bin/grep -Fx fra "$languages_file" >/dev/null || fail ;;
      eng+fra)
        /usr/bin/grep -Fx eng "$languages_file" >/dev/null || fail
        /usr/bin/grep -Fx fra "$languages_file" >/dev/null || fail
        ;;
    esac
    eng_hash=$($SHA256SUM "$TESSDATA/eng.traineddata" | /usr/bin/awk '{print $1}')
    fra_hash=$($SHA256SUM "$TESSDATA/fra.traineddata" | /usr/bin/awk '{print $1}')
    case "$language" in
      eng)
        printf '{"id":"tesseract","version":"%s","languages":["eng"],"trainedData":[{"language":"eng","sha256":"%s"}]}' \
          "$version" "$eng_hash" > "$result_file"
        ;;
      fra)
        printf '{"id":"tesseract","version":"%s","languages":["fra"],"trainedData":[{"language":"fra","sha256":"%s"}]}' \
          "$version" "$fra_hash" > "$result_file"
        ;;
      eng+fra)
        printf '{"id":"tesseract","version":"%s","languages":["eng","fra"],"trainedData":[{"language":"eng","sha256":"%s"},{"language":"fra","sha256":"%s"}]}' \
          "$version" "$eng_hash" "$fra_hash" > "$result_file"
        ;;
    esac
    ;;
  recognize)
    pgm_magic=$(/usr/bin/head -c 2 "$payload_file")
    [ "$pgm_magic" = 'P5' ] || fail
    (
      output_blocks=$(( (max_output_bytes + 511) / 512 ))
      ulimit -f "$output_blocks" || exit 74
      /usr/bin/cat "$payload_file" | run_bounded "$timeout_ms" "$TESSERACT" \
        stdin stdout --tessdata-dir "$TESSDATA" --psm 6 -l "$language" tsv \
        > "$result_file" 2>/dev/null
    ) || fail
    ;;
esac

result_size=$(/usr/bin/wc -c < "$result_file" | /usr/bin/tr -d '[:space:]')
pgm_size=$(/usr/bin/wc -c < "$pgm_file" | /usr/bin/tr -d '[:space:]')
[ "$result_size" -le "$max_output_bytes" ] || fail
[ "$pgm_size" -le "$max_decoded_bytes" ] || fail
manifest_size=$(/usr/bin/wc -c < "$MANIFEST" | /usr/bin/tr -d '[:space:]')
[ "$manifest_size" -gt 0 ] || fail
[ "$manifest_size" -le 65536 ] || fail

printf '%s\n' "$PROTOCOL_RESPONSE"
printf 'status=ok\n'
printf 'operation=%s\n' "$operation"
printf 'source-sha256=%s\n' "$source_digest"
printf 'manifest-length=%s\n' "$manifest_size"
printf 'result-length=%s\n' "$result_size"
printf 'pgm-length=%s\n' "$pgm_size"
printf '\n'
/usr/bin/cat "$MANIFEST" "$result_file" "$pgm_file"
