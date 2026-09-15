# Finance OCR runtime package

This directory is the release input for the native image reader used by the
Finance worker. The root `Dockerfile` installs exact Debian Bookworm package
versions into the `worker` target and also emits a minimal `finance-ocr`
target containing only ImageMagick, Tesseract and the approved English and
French traineddata.

The generated runtime manifest at
`/usr/local/share/emdo/finance-ocr-runtime.json` records the absolute paths and
SHA-256 digests consumed by the worker adapter. The adapter must require this
manifest in a release environment; PATH discovery is only suitable for local
development. The package does not authorize OCR output for posting or
mapping. OCR remains an untrusted source candidate until a separate review
binds exact words and regions to the encrypted original evidence.

The `finance-ocr` target is deliberately a healthchecked native image rather
than a network service. It contains no EMDO application, database client,
provider credentials or shell entrypoint that accepts a caller supplied
command. Run it as an isolated helper when a deployment chooses the
container boundary:

```sh
docker run --rm \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 32 \
  --memory 128m \
  --cpus 1 \
  --tmpfs /tmp:size=64m,noexec,nosuid,nodev,mode=0700,uid=10003,gid=10004 \
  --user 10003:10004 \
  ghcr.io/panic80/emdo-finance-ocr@sha256:<release-digest>
```

The native process protocol is stdin/stdout only (`native-stdin-v1`); no
uploaded path, URL, delegate, PDF, SVG, or remote resource is accepted. The
installed `/usr/local/bin/emdo-finance-ocr-helper` accepts exactly one
`EMDO-FINANCE-OCR-HELPER-V1` request and emits one bounded
`EMDO-FINANCE-OCR-HELPER-V1-RESPONSE` frame. Requests carry the original bytes
and their expected SHA-256 whenever a native stage runs. The helper hashes
those bytes before decoding, reruns the immutable runtime healthcheck, and
returns only the requested identify, PGM, provenance, or TSV stage. The worker
checks the response digest and manifest, validates lengths, and never passes a
caller-supplied command or path.

Use the fixed entrypoint override below for a manual single-request stdio probe.
Normal image startup runs the Unix socket supervisor:

```sh
docker run --rm --interactive \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 32 \
  --memory 128m \
  --cpus 1 \
  --tmpfs /tmp:size=64m,noexec,nosuid,nodev,mode=0700,uid=10003,gid=10004 \
  --user 10003:10004 \
  --entrypoint /usr/local/bin/emdo-finance-ocr-helper \
  ghcr.io/panic80/emdo-finance-ocr@sha256:<release-digest>
```

The command above documents the release isolation contract; the worker never
opens a Docker socket or starts Docker. A deployment supervisor must provide
the restricted process/container boundary and pass its stdin/stdout to the
worker's fixed helper transport. The worker's direct local adapter path remains
available only as an explicit non-isolated development path; an isolated
configuration has no local fallback. The Finance UI continues to expose OCR as review-only source data, including
when the isolated helper is enabled.

The helper image now starts `socket-server.mjs`, a single-request-at-a-time
supervisor at `/run/emdo/finance-ocr/helper.sock`. It launches only the fixed
helper executable, strips inherited environment values, bounds both byte streams,
and kills the helper process group on timeout or disconnect. It has no TCP
listener. The Compose overlay shares only the socket directory: helper UID
10003/GID 10004 can write it; the worker receives supplementary GID 10004 and a
read-only mount. No Docker control socket or application credentials are shared.
The image copies only the Node executable from a digest-pinned runtime stage.

Container build and runtime acceptance are still required before enabling this
transport in production. The direct `--entrypoint` command above remains a
manual stdio probe; normal container startup uses the Unix socket supervisor.

## Repeatable local container acceptance

After building the `finance-ocr` Docker target, run:

```sh
EMDO_OCR_IMAGE=emdo-finance-ocr:local-integration bash infra/scripts/verify-finance-ocr-runtime.sh
```

This opt-in check bundles the actual worker adapter, starts the helper and client
in separate network-disabled containers, and verifies synthetic financial text
and a blank image through the fixed Unix socket. Both results must retain the
original source digest and approved engine provenance. Containers and the socket
volume are removed on exit. The committed PNG is synthetic, not customer data.
This checks the native transport; it does not prove upload persistence, review,
posting, or staging deployment.

## Durable image import acceptance

Run `bash infra/scripts/verify-finance-image-durable.sh` after building the same
OCR image. This opt-in verifier creates an isolated PostgreSQL database, applies
the current migration journal, and runs the actual worker with the Unix socket
helper. A provider-free proposal fixture is bound to the real extracted image;
explicit cell selection and mapping review lead to a reviewed normalized import
and a posted journal. It verifies original encrypted evidence, source and
extraction digests, exact decimal amounts, and retry receipts. It does not call
Astra or prove staging deployment. All fixture data is synthetic. Owned containers,
volumes, and the private Docker network are removed on exit.
