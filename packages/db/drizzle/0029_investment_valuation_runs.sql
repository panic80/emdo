CREATE TABLE "emdo"."finance_valuation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"calculation_version" text NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "finance_valuation_runs_shape" CHECK (jsonb_typeof(input_snapshot)='object' and jsonb_typeof(result)='object' and length(calculation_version)>0)
);
--> statement-breakpoint
ALTER TABLE "emdo"."finance_valuation_runs" ADD CONSTRAINT "finance_valuation_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_valuation_runs" ADD CONSTRAINT "finance_valuation_runs_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_valuation_runs" ADD CONSTRAINT "finance_valuation_runs_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_valuation_runs_lookup" ON "emdo"."finance_valuation_runs" USING btree ("workspace_id","book_id","created_at","id");--> statement-breakpoint
ALTER TABLE emdo.finance_valuation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_valuation_runs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON emdo.finance_valuation_runs FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow;
GRANT SELECT,INSERT ON emdo.finance_valuation_runs TO emdo_app;
CREATE POLICY finance_valuation_runs_read ON emdo.finance_valuation_runs FOR SELECT TO emdo_app USING (emdo.finance_book_access(workspace_id,book_id));
CREATE POLICY finance_valuation_runs_insert ON emdo.finance_valuation_runs FOR INSERT TO emdo_app WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','preparer','approver']));
CREATE TRIGGER a_lock_book BEFORE INSERT ON emdo.finance_valuation_runs FOR EACH ROW EXECUTE FUNCTION emdo.lock_finance_book_mutation();
