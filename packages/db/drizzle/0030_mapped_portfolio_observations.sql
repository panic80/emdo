
ALTER TABLE "emdo"."finance_observed_positions" ADD COLUMN "reported_book_cost" numeric(38, 12);--> statement-breakpoint
ALTER TABLE "emdo"."finance_observed_positions" ADD COLUMN "reported_price" numeric(38, 12);--> statement-breakpoint
ALTER TABLE "emdo"."finance_observed_positions" ADD COLUMN "reported_accrued_interest" numeric(38, 12);--> statement-breakpoint
ALTER TABLE "emdo"."finance_observed_positions" ADD COLUMN "mapping_id" uuid;--> statement-breakpoint
ALTER TABLE "emdo"."finance_observed_positions" ADD COLUMN "source_facts" jsonb;--> statement-breakpoint
ALTER TABLE "emdo"."finance_observed_positions" ADD CONSTRAINT "finance_observed_positions_mapping" FOREIGN KEY ("workspace_id","book_id","mapping_id") REFERENCES "emdo"."finance_report_mapping_versions"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_observed_positions" ADD CONSTRAINT "finance_observed_positions_mapped_source" UNIQUE("workspace_id","book_id","financial_account_id","evidence_id","mapping_id","source_row");--> statement-breakpoint
ALTER TABLE "emdo"."finance_observed_positions" ADD CONSTRAINT "finance_observed_positions_source_facts" CHECK ((mapping_id is null and source_facts is null) or (mapping_id is not null and source_facts is not null and jsonb_typeof(source_facts)='object'));--> statement-breakpoint
ALTER TABLE "emdo"."finance_observed_positions" ADD CONSTRAINT "finance_observed_positions_reported_amounts" CHECK ((reported_book_cost is null or (reported_book_cost<>'NaN'::numeric and currency is not null)) and (reported_price is null or (reported_price<>'NaN'::numeric and currency is not null)) and (reported_accrued_interest is null or (reported_accrued_interest<>'NaN'::numeric and currency is not null)));--> statement-breakpoint
CREATE FUNCTION emdo.check_mapped_position() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.mapping_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM emdo.finance_report_mapping_versions m
    WHERE m.workspace_id=NEW.workspace_id AND m.book_id=NEW.book_id AND m.id=NEW.mapping_id
      AND m.status='approved' AND m.report_type='investment-positions'
      AND NEW.source_facts->>'mappingVersion'=m.version::text
  ) THEN RAISE EXCEPTION 'mapped position requires an approved portfolio mapping version' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_mapped_position BEFORE INSERT ON emdo.finance_observed_positions FOR EACH ROW EXECUTE FUNCTION emdo.check_mapped_position();
REVOKE ALL ON FUNCTION emdo.check_mapped_position() FROM PUBLIC;
