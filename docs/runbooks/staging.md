# On-demand staging

Staging runs on the production VPS only on demand and uses separate networks,
volumes, credentials, keys, and synthetic data.

1. Confirm production is healthy.
2. Confirm at least 1.75 GiB available memory and 10 GiB free disk.
3. Select the successful `main` publish run and exact image digests.
4. Run `infra/scripts/preflight-staging.sh`.
5. Run `infra/scripts/deploy-staging.sh`; refuse a non-empty database or any
   production provider credential.
6. Run `infra/scripts/run-staging-acceptance.sh` and archive the safe result
   artifact. The wrapper first requires all Compose services healthy, then the
   release-image CLI requires the exact version-1 API readiness groups and
   components documented in `docs/deployment/README.md`; neither check
   substitutes for the other.
7. Run `infra/scripts/teardown-staging.sh`. Confirm the independent teardown
   timer is installed before declaring the window safe.

The six steady-state staging services are capped near 1.25 GiB. A green local
Compose render is not proof of same-VPS staging.
