# Production release

Production accepts only the exact digests and source commit that passed staging.
GitHub's protected `production` environment supplies the approval and secrets.

1. Verify the staging acceptance artifact and digest set.
2. Create a Hostinger manual snapshot and wait for provider-confirmed
   completion.
3. Run an encrypted logical backup and verify its age and checksum.
4. Manually approve the protected production workflow.
5. Apply only backward-compatible migrations and pg-boss schema provisioning.
6. Start the exact image digests and require API, worker, PostgreSQL,
   PowerSync, web, and Caddy readiness.
7. Promote the deployment lock only after health checks complete.

If health fails, retain the pending deployment record and use the protected
rollback path. Do not reverse SQL. If the previous image is incompatible with
the current schema, choose a forward fix or an explicitly authorized outage
restore.
