# Isolated PDF page renderer foundation

This package renders one explicitly requested original PDF page into PNG. It
cannot OCR, propose a mapping, approve, post, fetch evidence, or access a database.
It is not connected to the Finance upload pipeline or production service.

The application-side transport defaults to the fixed Unix socket
`/run/emdo/finance-pdf-render/helper.sock`. The dedicated image starts its socket
supervisor, accepts one active request at a time, and spawns the fixed
`/usr/local/bin/emdo-finance-pdf-render-helper` with no arguments and a clean
environment. Input/output/diagnostics are bounded. Disconnect, timeout, and
failure kill the helper process group. The application gets no Docker socket,
helper commands, application credentials, or network access to the container.

A process transport remains available for tests or an already isolated process
supervisor. It is not an OS sandbox by itself. The worker-thread renderer alone
also cannot enforce hard native-code cancellation.

The helper socket directory is mode 0770 owned by 10005:10005; its socket is 0660. A worker uses supplementary group 10005 and mounts only the named socket
volume read-only at the same path. The helper mounts that volume read-write.
The two-container acceptance uses a different client UID, 10006, with the
shared socket GID 10005, and disables networking on both containers.

## Build without installing dependencies

`build.mjs` uses already-installed esbuild, PDF.js 5.4.296, and native canvas
0.1.80. It bundles only the helper/renderer and copies their PDF.js/canvas/native
packages. It does not copy the application closure or environment files.

A macOS build contains macOS native code and is **not deployable to Linux**. For
a Linux artifact, the offline builder can copy the exact dependency closure
from a locally installed Linux worker image. It resolves that image to its
immutable local image ID, checks dependency versions, and records the image ID
and architecture in `linux-provenance.json`:

```sh
node infra/finance-pdf-render/build-linux-artifact.mjs \
  /tmp/emdo-pdf-render-build-context/runtime emdo-finance-worker:51f0623-amd64

docker build --platform linux/amd64 \
  --file infra/finance-pdf-render/Dockerfile \
  --tag emdo-finance-pdf-render:local-foundation \
  /tmp/emdo-pdf-render-build-context

node infra/finance-pdf-render/verify-linux.mjs \
  /tmp/emdo-pdf-render-build-context/runtime \
  emdo-finance-pdf-render:local-foundation bundled
```

The dedicated Dockerfile uses the pinned Node 24.13.0 Bookworm base. Artifact
architecture must match the target image. The local verification creates a
synthetic mixed PDF, sends original bytes over stdin, and checks original and
rendered SHA-256 plus page identity under network-none, read-only root,
non-root UID 10005, 256 MiB memory, one CPU, 32 processes, and bounded tmpfs.
The verification container is removed afterward. This is local infrastructure
proof, not deployment or completed scanned-PDF import support.

## Protocol

One request per process; stdout contains exactly one response. No shell parsing
or uploaded filenames are involved. Both frames contain a magic ASCII line,
a four-byte unsigned big-endian JSON-header length, the UTF-8 JSON header, then
exact binary bytes. Header maximum is 2048 bytes. Maximum original PDF and PNG
sizes are each 2 MiB. Input EOF terminates a direct stdio request. On the Unix
socket, the declared header/body length terminates the request while the client
keeps its write side open; EOF therefore means cancellation. The supervisor
closes helper stdin only after receiving the exact complete frame.

- Request magic: `EMDO-FINANCE-PDF-RENDER-V1\n`
- Request header: `sourceDigest`, `pageNumber` (1-based, at most 25), `scale`
  (greater than zero, at most four), `byteLength`.
- Response magic: `EMDO-FINANCE-PDF-RENDER-V1-RESPONSE\n`
- Rendered response: `status`, `render`, `pngBytes`, `runtime`, then PNG bytes.
- Unavailable response: `status`, `reason`, `pngBytes: 0`, `runtime`; no bytes.

`render` binds original PDF SHA-256, total page count, selected page, rotation,
scale, dimensions, PNG SHA-256, and PDF.js version. `runtime` binds exact PDF.js
and canvas versions. The transport rejects mismatched bindings, unexpected
keys, trailing bytes, malformed headers, and unbounded diagnostics/output.
Rendering preserves selected-page identity; it never claims whole-document
coverage or authoritative text.

The isolated socket lifecycle is implemented and locally verified. Production
integration still needs an approved immutable renderer image and an explicit
worker socket-volume/group configuration. No production compose, root
Dockerfile, or standardization feature flag is changed by these files.

Run the real worker transport across two network-disabled containers with:

```sh
node infra/finance-pdf-render/verify-socket-linux.mjs \
  emdo-finance-pdf-render:local-foundation
```

The test verifies page/digest bindings, rejects concurrent requests, and checks
that disconnecting an incomplete request releases the helper for a subsequent
render. It also holds an incomplete request until the supervisor deadline and
verifies recovery afterward. The fixture client is separately bundled and mounted read-only for this
test; it is not part of the dedicated runtime artifact.
