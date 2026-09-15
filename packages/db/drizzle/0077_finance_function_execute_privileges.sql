-- Keep maintenance runner authority exclusive to its declared entrypoints.
-- Trigger invocation remains available through the existing table operations.
REVOKE EXECUTE ON FUNCTION emdo.check_invoice_review_draft() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION emdo.enforce_finance_legacy_migration_run() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION emdo.enforce_finance_legacy_migration_record() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION emdo.reject_finance_legacy_migration_history_mutation() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION emdo.lot_cost_at_quantity(numeric, numeric, numeric, integer) FROM PUBLIC;
--> statement-breakpoint
-- The invoker-security lot allocation trigger runs under the application role.
GRANT EXECUTE ON FUNCTION emdo.lot_cost_at_quantity(numeric, numeric, numeric, integer) TO emdo_app;
