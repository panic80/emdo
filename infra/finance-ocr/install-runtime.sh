#!/bin/sh
set -eu

# All values below are release inputs. The base image is digest-pinned in the
# root Dockerfile; these package versions and traineddata digests make the
# native OCR surface reproducible within that image family.
readonly IMAGEMAGICK_VERSION='8:6.9.11.60+dfsg-1.6+deb12u13'
readonly TESSERACT_VERSION='5.3.0-2'
readonly TESSERACT_LANG_VERSION='1:4.1.0-2'
readonly CONVERT_BINARY_SHA256='98cde8b245cd229a92e8a89505786098175e97d43f4b958874bbaaf05f3924af'
readonly IDENTIFY_BINARY_SHA256='d4a9b582c39c3aba2d0b42b4038b53f733ecceba4a8914fcd99828f7fe8e7ab2'
readonly TESSERACT_BINARY_SHA256='1e8c7ce7f27d2d1c902fb648efed443483f2a8fc7b60c48a5d3b61d647a2649e'
readonly ENG_TRAINEDDATA_SHA256='7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'
readonly FRA_TRAINEDDATA_SHA256='ced037562e8c80c13122dece28dd477d399af80911a28791a66a63ac1e3445ca'

readonly bundle_dir=${1:?usage: install-runtime.sh <bundle-directory>}
readonly runtime_dir='/usr/local/share/emdo'
readonly tessdata_dir='/usr/share/tesseract-ocr/5/tessdata'

test -r "$bundle_dir/ImageMagick-policy.xml"
test -r "$bundle_dir/magick"
test -r "$bundle_dir/helper-stdio.sh"
test -r "$bundle_dir/runtime-healthcheck.sh"

cat > /etc/apt/sources.list.d/emdo-finance-ocr.list <<'EOF'
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://deb.debian.org/debian bookworm main
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://security.debian.org/debian-security bookworm-security main
EOF

apt-get update
apt-get install --yes --no-install-recommends \
  "imagemagick=$IMAGEMAGICK_VERSION" \
  "imagemagick-6.q16=$IMAGEMAGICK_VERSION" \
  "tesseract-ocr=$TESSERACT_VERSION" \
  "tesseract-ocr-eng=$TESSERACT_LANG_VERSION" \
  "tesseract-ocr-fra=$TESSERACT_LANG_VERSION"

test "$(dpkg-query -W -f='${Version}' imagemagick-6.q16)" = "$IMAGEMAGICK_VERSION"
test "$(dpkg-query -W -f='${Version}' tesseract-ocr)" = "$TESSERACT_VERSION"
test "$(dpkg-query -W -f='${Version}' tesseract-ocr-eng)" = "$TESSERACT_LANG_VERSION"
test "$(dpkg-query -W -f='${Version}' tesseract-ocr-fra)" = "$TESSERACT_LANG_VERSION"

install -d -m 0755 /etc/ImageMagick-6 "$runtime_dir"
install -m 0444 "$bundle_dir/ImageMagick-policy.xml" /etc/ImageMagick-6/policy.xml
install -m 0555 "$bundle_dir/magick" /usr/local/bin/magick
install -m 0555 "$bundle_dir/helper-stdio.sh" /usr/local/bin/emdo-finance-ocr-helper
install -m 0555 "$bundle_dir/runtime-healthcheck.sh" /usr/local/bin/emdo-finance-ocr-runtime-healthcheck

test "$(tesseract --version 2>/dev/null | sed -n '1s/^tesseract //p')" = '5.3.0'
test "$(sha256sum /usr/bin/convert-im6.q16 | awk '{print $1}')" = "$CONVERT_BINARY_SHA256"
test "$(sha256sum /usr/bin/identify-im6.q16 | awk '{print $1}')" = "$IDENTIFY_BINARY_SHA256"
test "$(sha256sum /usr/bin/tesseract | awk '{print $1}')" = "$TESSERACT_BINARY_SHA256"
test "$(sha256sum "$tessdata_dir/eng.traineddata" | awk '{print $1}')" = "$ENG_TRAINEDDATA_SHA256"
test "$(sha256sum "$tessdata_dir/fra.traineddata" | awk '{print $1}')" = "$FRA_TRAINEDDATA_SHA256"

magick_sha256="$(sha256sum /usr/local/bin/magick | awk '{print $1}')"
policy_sha256="$(sha256sum /etc/ImageMagick-6/policy.xml | awk '{print $1}')"
eng_sha256="$(sha256sum "$tessdata_dir/eng.traineddata" | awk '{print $1}')"
fra_sha256="$(sha256sum "$tessdata_dir/fra.traineddata" | awk '{print $1}')"

cat > "$runtime_dir/finance-ocr-runtime.json" <<EOF
{
  "magick": {"path": "/usr/local/bin/magick", "sha256": "$magick_sha256"},
  "tesseract": {"path": "/usr/bin/tesseract", "sha256": "$TESSERACT_BINARY_SHA256", "version": "5.3.0"},
  "trainedData": [
    {"language": "eng", "path": "$tessdata_dir/eng.traineddata", "sha256": "$eng_sha256"},
    {"language": "fra", "path": "$tessdata_dir/fra.traineddata", "sha256": "$fra_sha256"}
  ]
}
EOF

cat > "$runtime_dir/finance-ocr-runtime.sha256" <<EOF
$magick_sha256  /usr/local/bin/magick
$CONVERT_BINARY_SHA256  /usr/bin/convert-im6.q16
$IDENTIFY_BINARY_SHA256  /usr/bin/identify-im6.q16
$TESSERACT_BINARY_SHA256  /usr/bin/tesseract
$eng_sha256  $tessdata_dir/eng.traineddata
$fra_sha256  $tessdata_dir/fra.traineddata
EOF

cat > "$runtime_dir/finance-ocr-policy.sha256" <<EOF
$policy_sha256  /etc/ImageMagick-6/policy.xml
EOF

chmod 0444 "$runtime_dir/finance-ocr-runtime.json" \
  "$runtime_dir/finance-ocr-runtime.sha256" \
  "$runtime_dir/finance-ocr-policy.sha256"

# Prove the exact binaries and policy before the layer is committed.
/usr/local/bin/emdo-finance-ocr-runtime-healthcheck

rm -f /etc/apt/sources.list.d/emdo-finance-ocr.list
rm -rf /var/lib/apt/lists/*
