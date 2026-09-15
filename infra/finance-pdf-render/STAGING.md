# Private staging PDF OCR wiring

This opt-in overlay connects the dedicated renderer to the API and worker. It
is not selected by a default launcher and does not deploy or enable production.
Use a fresh private staging project and synthetic documents only. The saved
inspection reader needs no rendering; explicit reviewed mapping/import invokes
the API renderer to verify the selected original page against saved raster
provenance. The worker uses rendering plus image OCR during gated PDF extraction.

Use release-matched API/worker images and an immutable dedicated renderer image
(`repository@sha256:...`), built for the staging host architecture as described
in [README.md](README.md). Set `FINANCE_PDF_RENDER_IMAGE` and `FINANCE_OCR_IMAGE`
to their verified immutable references. The renderer must contain the fixed
socket supervisor, PDF.js 5.4.296 and canvas 0.1.80; an application worker image
is not a substitute. This Compose file requires the variable but cannot validate
its digest syntax. Do not use mutable tags for a staging run.

Include overlays in this order, in the existing authorized private staging
workflow. Both helper profiles are required:

```sh
docker compose \
  -f infra/compose/compose.yml \
  -f infra/compose/compose.staging.yml \
  -f infra/compose/compose.finance-staging.yml \
  -f infra/compose/compose.finance-ocr.yml \
  -f infra/compose/compose.finance-pdf-render.yml \
  --profile finance-ocr --profile finance-pdf-render \
  config --quiet
```

Supply the existing staging workflow's run-scoped environment and credentials,
including `STAGING_RUN_ID`. The overlay names the project
`emdo-staging-${STAGING_RUN_ID}`; preserve that name in the staging workflow and
never reuse a production project. `config` validates only; it does not start,
pull, build, migrate, call providers or prove runtime readiness. Avoid printing
resolved configuration containing real environment values. For credential-free
structural checks, use `config --no-env-resolution --no-interpolate --quiet`.
That mode does not fully check dependency consistency. The focused Compose test
uses fresh empty environment files and synthetic interpolation to verify the
merged graph without reading real credentials.
No additional API transport flag is needed: its injected renderer already uses
the fixed socket when a reviewed PDF OCR selection requests regeneration.

The existing OCR overlay sets worker `EMDO_FINANCE_IMAGE_OCR_TRANSPORT=unix-socket`;
this overlay sets `EMDO_FINANCE_PDF_RENDER_TRANSPORT=unix-socket`. Worker startup
rejects PDF rendering without isolated OCR. Its dependency on `finance-ocr`
also makes a missing OCR overlay/profile a Compose configuration error. API and
worker gain supplementary GID 10005 and mount only the renderer socket volume
read-only. The OCR overlay's worker GID 10004/socket mount must remain merged.
No Docker control socket or helper executable command is supplied to either app.

The dedicated helper has no network, credentials, database, published port or
application volume. It uses UID/GID 10005, read-only root, all capabilities dropped,
no-new-privileges, 256 MiB memory, one CPU, 32 processes and bounded private tmpfs.
Its image creates `/run/emdo/finance-pdf-render` mode 0770 owned by 10005:10005;
the supervisor creates `helper.sock` mode 0660. Use a fresh project-scoped named
volume so Docker initializes that ownership from the image. Never repair an
old shared volume by broadening its permissions. The healthcheck verifies the
socket exists; it does not prove successful rendering. One active renderer
request is supported; a busy response remains unavailable and does not imply
empty source data.

For local end-to-end verification before staging, run the synthetic acceptance:

```sh
bash infra/scripts/verify-finance-pdf-durable.sh
```

This uses disposable PostgreSQL and isolated cached renderer/OCR images, a genuine
raster PDF, and real Tesseract. It checks saved original-page amount provenance,
explicit review before commit, a balanced CAD 123.45 journal and replay. The
proposal is a deterministic fixture, so this does not verify live Astra behavior.
It also does not verify the browser or a deployed staging environment. Consult
the script's image prerequisites before running it.

Before describing staging as verified, run a synthetic mixed embedded/scanned
PDF through upload, saved extraction and page inventory, then explicitly review
one original page and verify mapping/import provenance and replay. Confirm an
unresolved page stays unresolved and wrong digest/page/revision or revoked access
fails. Rendering alone is not OCR accuracy, whole-document coverage, approval,
posting or provider-budget proof. The existing two-container renderer acceptance
in README.md proves local transport/isolation only.

To stop opting in for a later run, omit this overlay and the PDF helper profile
and retain the normal disabled worker default. Existing saved facts remain
readable; page-regeneration operations are unavailable without the helper.
Use the private staging workflow's normal teardown for its project and fresh
socket volume; do not remove another project's volumes.
