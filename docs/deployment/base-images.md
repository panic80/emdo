# Base image pin verification

The build and runtime base images retain readable release tags and are pinned
to Docker Hub manifest-list digests. This prevents an upstream tag move from
silently changing an EMDO image build while preserving the reviewed version.

| Verified (UTC) | Docker Hub tag                              | Manifest-list digest                                                      |
| -------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| 2026-08-09     | `library/node:24.13.0-bookworm-slim`        | `sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f` |
| 2026-08-09     | `nginxinc/nginx-unprivileged:1.29.1-alpine` | `sha256:27985295bdb22a1ef8f712863210bd5877c0f3006494a593e86b3fe0fa55467e` |

The verification source is Docker Hub's primary Registry HTTP API: the script
obtains a repository-scoped pull token from `auth.docker.io`, requests the OCI
index/manifest list from `registry-1.docker.io`, compares the
`Docker-Content-Digest` response header, and then checks every Dockerfile pin.
Run:

```bash
node infra/scripts/verify-base-image-pins.mjs
```

Run this command during an intentional base-image update. Review upstream
release notes and vulnerability results, replace both the recorded digest and
Dockerfile reference together, and rerun the static container tests. Do not
automatically accept a moved tag.
