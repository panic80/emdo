CREATE TABLE "emdo"."finance_automation_journal_draft_events" (
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"event" jsonb NOT NULL,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_automation_journal_draft_events_draft_id_revision_pk" PRIMARY KEY("draft_id","revision"),
	CONSTRAINT "journal_draft_event_shape" CHECK ("emdo"."finance_automation_journal_draft_events"."revision">0 and "emdo"."finance_automation_journal_draft_events"."kind" in ('reviewed','posted','discarded') and jsonb_typeof("emdo"."finance_automation_journal_draft_events"."event")='object' and octet_length("emdo"."finance_automation_journal_draft_events"."event"::text)<=65536)
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_automation_journal_draft_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"automation_run_id" uuid NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source_batch_id" uuid NOT NULL,
	"source_batch_revision" integer NOT NULL,
	"source_snapshot_hash" text NOT NULL,
	"source_evidence_id" uuid NOT NULL,
	"source_digest" text NOT NULL,
	"source_mapping_hash" text NOT NULL,
	"currency" text NOT NULL,
	"item_count" integer NOT NULL,
	"amount" numeric(38, 12) NOT NULL,
	"source" jsonb NOT NULL,
	"proposal" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_draft_result_run" UNIQUE("automation_run_id"),
	CONSTRAINT "journal_draft_result_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "journal_draft_result_version" CHECK ("emdo"."finance_automation_journal_draft_results"."schema_version"=1 and "emdo"."finance_automation_journal_draft_results"."source_batch_revision">0 and "emdo"."finance_automation_journal_draft_results"."item_count">0 and "emdo"."finance_automation_journal_draft_results"."currency" in ('CAD','USD','MXN','EUR','KRW','JPY') and "emdo"."finance_automation_journal_draft_results"."amount">=0 and "emdo"."finance_automation_journal_draft_results"."amount"=round("emdo"."finance_automation_journal_draft_results"."amount",case when "emdo"."finance_automation_journal_draft_results"."currency" in ('JPY','KRW') then 0 else 2 end)),
	CONSTRAINT "journal_draft_result_hashes" CHECK ("emdo"."finance_automation_journal_draft_results"."source_snapshot_hash" ~ '^[a-f0-9]{64}$' and "emdo"."finance_automation_journal_draft_results"."source_digest" ~ '^[a-f0-9]{64}$' and "emdo"."finance_automation_journal_draft_results"."source_mapping_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "journal_draft_result_payload" CHECK (jsonb_typeof("emdo"."finance_automation_journal_draft_results"."source")='object' and jsonb_typeof("emdo"."finance_automation_journal_draft_results"."proposal")='object' and octet_length("emdo"."finance_automation_journal_draft_results"."source"::text)<=8000000 and octet_length("emdo"."finance_automation_journal_draft_results"."proposal"::text)<=8000000)
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_automation_journal_draft_states" (
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'review_required' NOT NULL,
	"review_decision" text,
	"review_reason" text,
	"review_actor_id" uuid,
	"review_at" timestamp with time zone,
	"posted_journal_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_automation_journal_draft_states_workspace_id_book_id_draft_id_pk" PRIMARY KEY("workspace_id","book_id","draft_id"),
	CONSTRAINT "journal_draft_state_shape" CHECK ("emdo"."finance_automation_journal_draft_states"."revision">=0 and "emdo"."finance_automation_journal_draft_states"."status" in ('review_required','approved','rejected','posted','discarded') and (("emdo"."finance_automation_journal_draft_states"."status"='review_required' and "emdo"."finance_automation_journal_draft_states"."review_decision" is null and "emdo"."finance_automation_journal_draft_states"."review_actor_id" is null and "emdo"."finance_automation_journal_draft_states"."review_at" is null) or ("emdo"."finance_automation_journal_draft_states"."status" in ('approved','rejected','posted') and "emdo"."finance_automation_journal_draft_states"."review_decision" is not null and "emdo"."finance_automation_journal_draft_states"."review_actor_id" is not null and "emdo"."finance_automation_journal_draft_states"."review_at" is not null) or ("emdo"."finance_automation_journal_draft_states"."status"='discarded' and (("emdo"."finance_automation_journal_draft_states"."review_decision" is null and "emdo"."finance_automation_journal_draft_states"."review_actor_id" is null and "emdo"."finance_automation_journal_draft_states"."review_at" is null) or ("emdo"."finance_automation_journal_draft_states"."review_decision" is not null and "emdo"."finance_automation_journal_draft_states"."review_actor_id" is not null and "emdo"."finance_automation_journal_draft_states"."review_at" is not null)))) and (("emdo"."finance_automation_journal_draft_states"."status"='posted') = (jsonb_array_length("emdo"."finance_automation_journal_draft_states"."posted_journal_ids")>0)) and (("emdo"."finance_automation_journal_draft_states"."status"<>'posted') = (jsonb_array_length("emdo"."finance_automation_journal_draft_states"."posted_journal_ids")=0)))
);
--> statement-breakpoint
ALTER TABLE "emdo"."finance_automation_journal_draft_events" ADD CONSTRAINT "journal_draft_event_state_scope" FOREIGN KEY ("workspace_id","book_id","draft_id") REFERENCES "emdo"."finance_automation_journal_draft_states"("workspace_id","book_id","draft_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_automation_journal_draft_events" ADD CONSTRAINT "journal_draft_event_actor" FOREIGN KEY ("actor_id") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_automation_journal_draft_results" ADD CONSTRAINT "journal_draft_result_run_scope" FOREIGN KEY ("workspace_id","book_id","automation_run_id") REFERENCES "emdo"."finance_automation_runs"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_automation_journal_draft_results" ADD CONSTRAINT "journal_draft_result_batch_scope" FOREIGN KEY ("workspace_id","book_id","source_batch_id") REFERENCES "emdo"."finance_normalized_imports"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_automation_journal_draft_results" ADD CONSTRAINT "journal_draft_result_evidence_scope" FOREIGN KEY ("workspace_id","book_id","source_evidence_id") REFERENCES "emdo"."finance_book_evidence"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_automation_journal_draft_states" ADD CONSTRAINT "journal_draft_state_result_scope" FOREIGN KEY ("workspace_id","book_id","draft_id") REFERENCES "emdo"."finance_automation_journal_draft_results"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_automation_journal_draft_states" ADD CONSTRAINT "journal_draft_state_actor" FOREIGN KEY ("review_actor_id") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Journal-draft automation stores an immutable proposal separately from its
-- review/post/discard projection.  This migration never enables the capability.
ALTER TABLE emdo.finance_automation_journal_draft_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_automation_journal_draft_results FORCE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_automation_journal_draft_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_automation_journal_draft_states FORCE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_automation_journal_draft_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_automation_journal_draft_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON emdo.finance_automation_journal_draft_results,
  emdo.finance_automation_journal_draft_states,
  emdo.finance_automation_journal_draft_events
  FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow;
GRANT SELECT,INSERT ON emdo.finance_automation_journal_draft_results TO emdo_finance_automation_executor;
GRANT SELECT,INSERT,UPDATE ON emdo.finance_automation_journal_draft_states TO emdo_finance_automation_executor;
GRANT SELECT,INSERT ON emdo.finance_automation_journal_draft_events TO emdo_finance_automation_executor;
CREATE POLICY journal_draft_result_executor ON emdo.finance_automation_journal_draft_results
  FOR ALL TO emdo_finance_automation_executor USING(true) WITH CHECK(true);
CREATE POLICY journal_draft_state_executor ON emdo.finance_automation_journal_draft_states
  FOR ALL TO emdo_finance_automation_executor USING(true) WITH CHECK(true);
CREATE POLICY journal_draft_event_executor ON emdo.finance_automation_journal_draft_events
  FOR ALL TO emdo_finance_automation_executor USING(true) WITH CHECK(true);
GRANT SELECT ON emdo.finance_automation_journal_draft_results,
  emdo.finance_automation_journal_draft_states,
  emdo.finance_automation_journal_draft_events TO emdo_app;
CREATE POLICY journal_draft_result_book_read ON emdo.finance_automation_journal_draft_results
  FOR SELECT TO emdo_app USING(emdo.finance_book_access(workspace_id,book_id));
CREATE POLICY journal_draft_state_book_read ON emdo.finance_automation_journal_draft_states
  FOR SELECT TO emdo_app USING(emdo.finance_book_access(workspace_id,book_id));
CREATE POLICY journal_draft_event_book_read ON emdo.finance_automation_journal_draft_events
  FOR SELECT TO emdo_app USING(emdo.finance_book_access(workspace_id,book_id));

-- The worker reads only the reviewed import snapshot and account/evidence
-- metadata through this executor-owned boundary.  No source table is writable.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_books','finance_financial_accounts','finance_ledger_accounts',
    'finance_periods','finance_book_evidence','finance_normalized_imports',
    'finance_normalized_import_rows','finance_import_row_reviews',
    'finance_normalized_import_amount_components','finance_economic_transactions',
    'finance_journals','finance_journal_lines'
  ] LOOP
    EXECUTE format('GRANT SELECT ON emdo.%I TO emdo_finance_automation_executor',t);
    EXECUTE format('CREATE POLICY journal_draft_source_executor ON emdo.%I FOR SELECT TO emdo_finance_automation_executor USING(true)',t);
  END LOOP;
END $$;

CREATE FUNCTION emdo.reject_finance_journal_draft_event_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,emdo AS $$
BEGIN
  RAISE EXCEPTION 'finance-journal-draft-event-immutable' USING ERRCODE='23514';
END $$;
ALTER FUNCTION emdo.reject_finance_journal_draft_event_mutation() OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.reject_finance_journal_draft_event_mutation() FROM PUBLIC;
CREATE TRIGGER immutable_journal_draft_events
  BEFORE UPDATE OR DELETE ON emdo.finance_automation_journal_draft_events
  FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_journal_draft_event_mutation();

CREATE FUNCTION emdo.validate_finance_journal_draft_event()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,emdo AS $$
DECLARE s emdo.finance_automation_journal_draft_states;
BEGIN
  SELECT * INTO s
    FROM emdo.finance_automation_journal_draft_states
   WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND draft_id=NEW.draft_id;
  IF NOT FOUND OR s.revision<>NEW.revision
     OR NEW.event->>'kind' IS DISTINCT FROM NEW.kind
     OR NEW.event->>'revision' IS DISTINCT FROM NEW.revision::text
     OR NEW.event->>'actorId' IS DISTINCT FROM NEW.actor_id::text THEN
    RAISE EXCEPTION 'finance-journal-draft-event-revision' USING ERRCODE='23514';
  END IF;
  IF NEW.kind='reviewed' AND (NEW.event->>'decision' NOT IN ('approved','rejected')
      OR NEW.event->>'reason' IS NULL AND NEW.event ? 'reason' = false) THEN
    RAISE EXCEPTION 'finance-journal-draft-review-event-invalid' USING ERRCODE='23514';
  ELSIF NEW.kind='posted' AND (jsonb_typeof(NEW.event->'journalIds') IS DISTINCT FROM 'array'
      OR jsonb_array_length(NEW.event->'journalIds')<1) THEN
    RAISE EXCEPTION 'finance-journal-draft-post-event-invalid' USING ERRCODE='23514';
  ELSIF NEW.kind='discarded' AND length(trim(coalesce(NEW.event->>'reason','')))<3 THEN
    RAISE EXCEPTION 'finance-journal-draft-discard-event-invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION emdo.validate_finance_journal_draft_event() OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.validate_finance_journal_draft_event() FROM PUBLIC;
CREATE TRIGGER validate_journal_draft_events
  BEFORE INSERT ON emdo.finance_automation_journal_draft_events
  FOR EACH ROW EXECUTE FUNCTION emdo.validate_finance_journal_draft_event();

-- Internal source snapshot.  The complete JSON is hashed, while only the
-- bounded public projection is persisted in a generated result.
CREATE FUNCTION emdo.finance_journal_draft_source_snapshot(w uuid,b uuid,p_batch_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER STABLE
SET search_path=pg_catalog,emdo AS $$
  SELECT jsonb_build_object(
    'batch',jsonb_build_object(
      'id',i.id,'revision',i.revision,'status',i.status,
      'financialAccountId',i.financial_account_id,'evidenceId',i.evidence_id,
      'mapping',i.mapping,'parserVersion',i.parser_version
    ),
    'book',jsonb_build_object(
      'id',fb.id,'entityId',fb.entity_id,'functionalCurrency',fb.functional_currency,
      'revision',fb.revision
    ),
    'financialAccount',jsonb_build_object(
      'id',a.id,'currency',a.currency,'ledgerAccountId',a.ledger_account_id,
      'active',a.active
    ),
    'evidence',jsonb_build_object(
      'id',e.id,'plaintextSha256',e.plaintext_sha256,'format',e.format,
      'byteSize',e.byte_size
    ),
    'ledgerAccounts',coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id',la.id,'code',la.code,'name',la.name,'kind',la.kind,'active',la.active
      ) ORDER BY la.id)
      FROM emdo.finance_ledger_accounts la
      WHERE la.workspace_id=i.workspace_id AND la.book_id=i.book_id
        AND (la.id=a.ledger_account_id OR la.id IN (
          SELECT r.counter_account_id
          FROM emdo.finance_normalized_import_rows r
          WHERE r.workspace_id=i.workspace_id AND r.book_id=i.book_id
            AND r.batch_id=i.id AND r.counter_account_id IS NOT NULL
          UNION
          SELECT c.ledger_account_id
          FROM emdo.finance_normalized_import_rows r
          JOIN emdo.finance_normalized_import_amount_components c
            ON c.workspace_id=r.workspace_id AND c.book_id=r.book_id
           AND c.row_id=r.id
          WHERE r.workspace_id=i.workspace_id AND r.book_id=i.book_id
            AND r.batch_id=i.id AND c.ledger_account_id IS NOT NULL
        ))
    ),'[]'::jsonb),
    'periods',coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id',p.id,'startsOn',p.starts_on,'endsOn',p.ends_on,'status',p.status,
        'closedAt',p.closed_at,'closedBy',p.closed_by
      ) ORDER BY p.starts_on,p.id)
      FROM emdo.finance_periods p
      WHERE p.workspace_id=i.workspace_id AND p.book_id=i.book_id
    ),'[]'::jsonb),
    'rows',coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id',r.id,'sourceRow',r.source_row,'sourceFacts',r.source_facts,
        'effectiveOn',r.effective_on::text,'description',r.description,
        'nativeAmount',r.native_amount::text,'externalId',r.external_id,
        'issues',r.issues,'status',r.status,'revision',r.revision,
        'counterAccountId',r.counter_account_id,'matchJournalId',r.match_journal_id,
        'fxRate',r.fx_rate::text,'fxSource',r.fx_source,
        'economicTransactionId',r.economic_transaction_id,
        'reviews',coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'revision',v.revision,'decision',v.decision,
            'previousFacts',v.previous_facts,'reviewedBy',v.reviewed_by
          ) ORDER BY v.revision)
          FROM emdo.finance_import_row_reviews v
          WHERE v.workspace_id=r.workspace_id AND v.book_id=r.book_id
            AND v.row_id=r.id
        ),'[]'::jsonb),
        'components',coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'id',c.id,'componentKind',c.component_kind,
            'nativeAmount',c.native_amount::text,'currency',c.currency,
            'sourceProvenance',c.source_provenance,'revision',c.revision,
            'reviewedNativeAmount',c.reviewed_native_amount::text,
            'reviewedCurrency',c.reviewed_currency,'inclusion',c.inclusion,
            'postingSide',c.posting_side,'ledgerAccountId',c.ledger_account_id,
            'fxRate',c.fx_rate::text,'fxSource',c.fx_source
          ) ORDER BY c.component_kind,c.id)
          FROM emdo.finance_normalized_import_amount_components c
          WHERE c.workspace_id=r.workspace_id AND c.book_id=r.book_id
            AND c.row_id=r.id
        ),'[]'::jsonb)
      ) ORDER BY r.source_row,r.id)
      FROM emdo.finance_normalized_import_rows r
      WHERE r.workspace_id=i.workspace_id AND r.book_id=i.book_id
        AND r.batch_id=i.id
    ),'[]'::jsonb)
  )
  FROM emdo.finance_normalized_imports i
  JOIN emdo.finance_financial_accounts a
    ON a.workspace_id=i.workspace_id AND a.book_id=i.book_id
   AND a.id=i.financial_account_id
  JOIN emdo.finance_book_evidence e
    ON e.workspace_id=i.workspace_id AND e.book_id=i.book_id AND e.id=i.evidence_id
  JOIN emdo.finance_books fb
    ON fb.workspace_id=i.workspace_id AND fb.id=i.book_id
  WHERE i.workspace_id=w AND i.book_id=b AND i.id=p_batch_id;
$$;
ALTER FUNCTION emdo.finance_journal_draft_source_snapshot(uuid,uuid,uuid) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.finance_journal_draft_source_snapshot(uuid,uuid,uuid) FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow;

-- Derive the exact proposal from the reviewed import source.  This helper is
-- called while the caller holds the workspace/book advisory lock; it never
-- accepts journal lines or arithmetic from the caller.
CREATE FUNCTION emdo.finance_journal_draft_derive(w uuid,b uuid,p_batch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,emdo AS $$
DECLARE
  batch_row record;
  row_record record;
  component record;
  book_currency text;
  functional_precision integer;
  row_functional numeric;
  component_functional numeric;
  component_contribution numeric;
  contribution numeric;
  component_count integer;
  line_count integer:=0;
  source_row_count integer;
  debit_total numeric:=0;
  source_components jsonb;
  source_rows jsonb:='[]'::jsonb;
  component_lines jsonb;
  row_lines jsonb;
  journals jsonb:='[]'::jsonb;
  snapshot jsonb;
  source jsonb;
  snapshot_hash text;
  mapping_hash text;
  source_digest text;
  cash_side text;
  amount_abs numeric;
BEGIN
  SELECT i.*,a.currency AS account_currency,a.ledger_account_id,
         e.plaintext_sha256 AS evidence_digest,
         fb.functional_currency AS functional_currency
    INTO batch_row
    FROM emdo.finance_normalized_imports i
    JOIN emdo.finance_financial_accounts a
      ON a.workspace_id=i.workspace_id AND a.book_id=i.book_id
     AND a.id=i.financial_account_id AND a.active
    JOIN emdo.finance_book_evidence e
      ON e.workspace_id=i.workspace_id AND e.book_id=i.book_id
     AND e.id=i.evidence_id
    JOIN emdo.finance_books fb
      ON fb.workspace_id=i.workspace_id AND fb.id=i.book_id
   WHERE i.workspace_id=w AND i.book_id=b AND i.id=p_batch_id;
  IF NOT FOUND OR batch_row.status<>'review' OR batch_row.revision<1 THEN
    RAISE EXCEPTION 'finance-journal-source-invalid' USING ERRCODE='23514';
  END IF;
  book_currency:=batch_row.functional_currency;
  functional_precision:=CASE WHEN book_currency IN ('JPY','KRW') THEN 0 ELSE 2 END;
  IF book_currency NOT IN ('CAD','USD','MXN','EUR','KRW','JPY')
     OR batch_row.account_currency NOT IN ('CAD','USD','MXN','EUR','KRW','JPY') THEN
    RAISE EXCEPTION 'finance-journal-source-currency-invalid' USING ERRCODE='23514';
  END IF;
  SELECT count(*)::integer INTO source_row_count
    FROM emdo.finance_normalized_import_rows r
   WHERE r.workspace_id=w AND r.book_id=b AND r.batch_id=p_batch_id;
  IF source_row_count<1 THEN
    RAISE EXCEPTION 'finance-journal-source-empty' USING ERRCODE='22023';
  END IF;
  IF source_row_count>10000 THEN
    RAISE EXCEPTION 'finance-journal-source-limit' USING ERRCODE='54000';
  END IF;
  PERFORM 1
    FROM emdo.finance_normalized_import_rows r
   WHERE r.workspace_id=w AND r.book_id=b AND r.batch_id=p_batch_id;
  snapshot:=emdo.finance_journal_draft_source_snapshot(w,b,p_batch_id);
  IF snapshot IS NULL THEN
    RAISE EXCEPTION 'finance-journal-source-invalid' USING ERRCODE='23514';
  END IF;
  source_digest:=batch_row.evidence_digest;
  mapping_hash:=encode(sha256(convert_to(batch_row.mapping::text,'UTF8')),'hex');
  snapshot_hash:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
  FOR row_record IN
    SELECT r.*
      FROM emdo.finance_normalized_import_rows r
     WHERE r.workspace_id=w AND r.book_id=b AND r.batch_id=p_batch_id
     ORDER BY r.source_row,r.id
  LOOP
    source_components:='[]'::jsonb;
    component_lines:='[]'::jsonb;
    component_count:=0;
    FOR component IN
      SELECT c.*
        FROM emdo.finance_normalized_import_amount_components c
         WHERE c.workspace_id=w AND c.book_id=b AND c.row_id=row_record.id
       ORDER BY c.component_kind,c.id
    LOOP
      component_count:=component_count+1;
      IF component_count>5 THEN
        RAISE EXCEPTION 'finance-journal-source-limit' USING ERRCODE='54000';
      END IF;
      source_components:=source_components || jsonb_build_array(
        jsonb_build_object('componentId',component.id,'revision',component.revision)
      );
    END LOOP;
    source_rows:=source_rows || jsonb_build_array(jsonb_build_object(
      'rowId',row_record.id,
      'sourceRow',row_record.source_row,
      'revision',row_record.revision,
      'componentRevisions',source_components
    ));
    IF row_record.status NOT IN ('ready','ignored','committed','matched') THEN
      RAISE EXCEPTION 'finance-journal-source-unresolved' USING ERRCODE='23514';
    END IF;
    -- Already ignored, committed, or explicitly matched rows are retained in
    -- the source hash but do not produce a second proposed journal.
    IF row_record.status<>'ready' OR row_record.match_journal_id IS NOT NULL THEN
      CONTINUE;
    END IF;
    IF row_record.effective_on IS NULL OR row_record.native_amount IS NULL
       OR row_record.fx_rate IS NULL OR row_record.fx_rate<=0
       OR row_record.fx_rate='NaN'::numeric OR row_record.native_amount=0
       OR row_record.native_amount='NaN'::numeric
       OR row_record.native_amount<>round(row_record.native_amount,CASE WHEN batch_row.account_currency IN ('JPY','KRW') THEN 0 ELSE 2 END)
       OR length(coalesce(row_record.description,''))=0
       OR jsonb_typeof(row_record.issues) IS DISTINCT FROM 'array'
       OR row_record.issues<>'[]'::jsonb OR length(coalesce(row_record.fx_source,''))=0
       OR (batch_row.account_currency=book_currency AND (row_record.fx_rate<>1 OR row_record.fx_source<>'identity'))
       OR (row_record.source_facts->'ofxSource'->>'sourceDigest' IS NOT NULL
           AND row_record.source_facts->'ofxSource'->>'sourceDigest'<>source_digest) THEN
      RAISE EXCEPTION 'finance-journal-source-invalid' USING ERRCODE='23514';
    END IF;
    row_functional:=round(row_record.native_amount*row_record.fx_rate,functional_precision);
    IF row_functional=0 THEN
      RAISE EXCEPTION 'finance-journal-source-zero-functional' USING ERRCODE='22023';
    END IF;
    amount_abs:=abs(row_functional);
    cash_side:=CASE WHEN row_record.native_amount>0 THEN 'debit' ELSE 'credit' END;
    row_lines:=jsonb_build_array(jsonb_build_object(
      'accountId',batch_row.ledger_account_id,
      'side',cash_side,
      'amount',trim_scale(amount_abs)::text,
      'currency',batch_row.account_currency,
      'nativeAmount',trim_scale(abs(row_record.native_amount))::text,
      'fxRate',trim_scale(row_record.fx_rate)::text,
      'fxSource',row_record.fx_source,
      'description',row_record.description
    ));
    line_count:=line_count+1;
    IF cash_side='debit' THEN debit_total:=debit_total+amount_abs; END IF;
    IF component_count>0 THEN
      IF row_record.counter_account_id IS NOT NULL OR row_record.match_journal_id IS NOT NULL THEN
        RAISE EXCEPTION 'finance-journal-component-target-conflict' USING ERRCODE='23514';
      END IF;
      contribution:=0;
      FOR component IN
        SELECT c.*
          FROM emdo.finance_normalized_import_amount_components c
         WHERE c.workspace_id=w AND c.book_id=b AND c.row_id=row_record.id
         ORDER BY c.component_kind,c.id
      LOOP
        IF component.reviewed_native_amount IS NULL
           OR component.reviewed_currency IS NULL
           OR component.inclusion IS NULL
           OR component.posting_side IS NULL
           OR component.ledger_account_id IS NULL
           OR component.fx_rate IS NULL OR component.fx_rate<=0
           OR component.fx_rate='NaN'::numeric
           OR length(coalesce(component.fx_source,''))=0
           OR component.inclusion<>'included-in-net'
           OR component.reviewed_native_amount='NaN'::numeric
           OR component.reviewed_native_amount<>round(component.reviewed_native_amount,CASE WHEN component.reviewed_currency IN ('JPY','KRW') THEN 0 ELSE 2 END)
           OR NOT EXISTS(SELECT FROM emdo.finance_ledger_accounts a
                          WHERE a.workspace_id=w AND a.book_id=b
                            AND a.id=component.ledger_account_id AND a.active)
           OR (component.reviewed_currency=book_currency
               AND (component.fx_rate<>1 OR component.fx_source<>'identity'))
           OR (component.reviewed_currency<>book_currency AND component.fx_source='identity') THEN
          RAISE EXCEPTION 'finance-journal-components-review-required' USING ERRCODE='23514';
        END IF;
        component_functional:=round(component.reviewed_native_amount*component.fx_rate,functional_precision);
        IF component.reviewed_native_amount<>0 AND component_functional=0 THEN
          RAISE EXCEPTION 'finance-journal-component-zero-functional' USING ERRCODE='22023';
        END IF;
        contribution:=contribution+CASE WHEN component.posting_side='debit'
          THEN abs(component_functional) ELSE -abs(component_functional) END;
        IF component_functional<>0 THEN
          component_lines:=component_lines || jsonb_build_array(jsonb_build_object(
            'accountId',component.ledger_account_id,
            'side',component.posting_side,
            'amount',trim_scale(abs(component_functional))::text,
            'currency',component.reviewed_currency,
            'nativeAmount',trim_scale(abs(component.reviewed_native_amount))::text,
            'fxRate',trim_scale(component.fx_rate)::text,
            'fxSource',component.fx_source,
            'description',row_record.description||' · '||component.component_kind
          ));
          line_count:=line_count+1;
          IF component.posting_side='debit' THEN debit_total:=debit_total+abs(component_functional); END IF;
        END IF;
      END LOOP;
      IF contribution<>-row_functional THEN
        RAISE EXCEPTION 'finance-journal-component-net-mismatch' USING ERRCODE='23514';
      END IF;
      row_lines:=row_lines || component_lines;
    ELSE
      IF row_record.counter_account_id IS NULL
         OR NOT EXISTS(SELECT FROM emdo.finance_ledger_accounts a
                        WHERE a.workspace_id=w AND a.book_id=b
                          AND a.id=row_record.counter_account_id AND a.active)
         OR row_record.counter_account_id=batch_row.ledger_account_id THEN
        RAISE EXCEPTION 'finance-journal-counter-account-invalid' USING ERRCODE='23514';
      END IF;
      row_lines:=row_lines || jsonb_build_array(jsonb_build_object(
        'accountId',row_record.counter_account_id,
        'side',CASE WHEN cash_side='debit' THEN 'credit' ELSE 'debit' END,
        'amount',trim_scale(amount_abs)::text,
        'currency',book_currency,
        'nativeAmount',trim_scale(amount_abs)::text,
        'fxRate','1',
        'fxSource','identity',
        'description',row_record.description
      ));
      line_count:=line_count+1;
      IF cash_side='credit' THEN debit_total:=debit_total+amount_abs; END IF;
    END IF;
    journals:=journals || jsonb_build_array(jsonb_build_object(
      'effectiveOn',row_record.effective_on::text,
      'description',row_record.description,
      'sourceReference','import:'||p_batch_id::text||':'||row_record.source_row::text,
      'lines',row_lines
    ));
  END LOOP;
  IF line_count<2 OR line_count>10000 OR jsonb_array_length(journals)=0
     OR debit_total<=0 THEN
    RAISE EXCEPTION 'finance-journal-proposal-empty' USING ERRCODE='22023';
  END IF;
  IF octet_length(journals::text)>8000000 OR octet_length(source_rows::text)>8000000 THEN
    RAISE EXCEPTION 'finance-journal-source-limit' USING ERRCODE='54000';
  END IF;
  source:=jsonb_build_object(
    'batchId',p_batch_id,
    'batchRevision',batch_row.revision,
    'snapshotHash',snapshot_hash,
    'evidenceId',batch_row.evidence_id,
    'sourceDigest',source_digest,
    'mappingHash',mapping_hash,
    'rows',source_rows
  );
  RETURN jsonb_build_object(
    'source',source,
    'proposal',jsonb_build_object('journals',journals),
    'itemCount',line_count,
    'currency',book_currency,
    'amount',trim_scale(debit_total)::text
  );
END $$;
ALTER FUNCTION emdo.finance_journal_draft_derive(uuid,uuid,uuid) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.finance_journal_draft_derive(uuid,uuid,uuid) FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow;
--> statement-breakpoint
-- Preparation is a reviewed, non-posting source binding.  It does not create
-- a result row or enable the capability; enqueueing is a separate command.
CREATE FUNCTION emdo.prepare_finance_journal_draft(w uuid,b uuid,k text,batch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,emdo AS $$
DECLARE
  receipt emdo.finance_command_receipts;
  request_hash text;
  derived jsonb;
  result jsonb;
BEGIN
  IF k IS NULL OR k !~ '^[A-Za-z0-9:._-]{1,128}$' OR batch_id IS NULL THEN
    RAISE EXCEPTION 'finance-journal-preparation-invalid' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM emdo.finance_automation_authority_epochs
   WHERE workspace_id=w FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||b::text,0));
  IF NOT emdo.finance_book_access(w,b,ARRAY['administrator','preparer','approver']) THEN
    RAISE EXCEPTION 'finance-journal-preparation-forbidden' USING ERRCODE='42501';
  END IF;
  request_hash:=encode(sha256(convert_to(jsonb_build_object(
    'bookId',b,'batchId',batch_id
  )::text,'UTF8')),'hex');
  SELECT * INTO receipt FROM emdo.finance_command_receipts
   WHERE workspace_id=w AND user_id=emdo.current_user_id()
     AND idempotency_key=k;
  IF FOUND THEN
    IF receipt.operation<>'automation.journal.prepare'
       OR receipt.payload_hash<>request_hash THEN
      RAISE EXCEPTION 'finance-journal-preparation-idempotency-conflict' USING ERRCODE='23505';
    END IF;
    RETURN receipt.result;
  END IF;
  derived:=emdo.finance_journal_draft_derive(w,b,batch_id);
  result:=jsonb_build_object(
    'journal',jsonb_build_object(
      'schemaVersion',1,
      'batchId',batch_id,
      'expectedBatchRevision',(derived->'source'->>'batchRevision')::integer,
      'expectedSnapshotHash',derived->'source'->>'snapshotHash'
    ),
    'itemCount',(derived->>'itemCount')::integer,
    'currency',derived->>'currency',
    'amount',derived->>'amount'
  );
  INSERT INTO emdo.finance_command_receipts(
    workspace_id,user_id,idempotency_key,operation,payload_hash,result
  ) VALUES(
    w,emdo.current_user_id(),k,'automation.journal.prepare',request_hash,result
  );
  RETURN result;
END $$;
ALTER FUNCTION emdo.prepare_finance_journal_draft(uuid,uuid,text,uuid) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.prepare_finance_journal_draft(uuid,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.prepare_finance_journal_draft(uuid,uuid,text,uuid) TO emdo_app;

-- Journal enqueue owns the reservation facts.  The caller may provide the
-- preparation values, but SQL derives and compares every one before inserting
-- the canonical intent and its journalReview binding.
CREATE FUNCTION emdo.enqueue_finance_journal_draft_automation(
  w uuid,b uuid,gid uuid,rid uuid,cap text,targets jsonb,curr text,amt text,journal jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,emdo AS $$
DECLARE
  g emdo.finance_automation_grants;
  r emdo.finance_automation_runs;
  derived jsonb;
  canonical_journal jsonb;
  review jsonb;
  payload jsonb;
  request_hash text;
  reason text;
  n numeric;
  target uuid;
BEGIN
  PERFORM 1 FROM emdo.finance_automation_authority_epochs
   WHERE workspace_id=w FOR UPDATE;
  PERFORM emdo.finance_automation_admin(w,b);
  SELECT * INTO g FROM emdo.finance_automation_grants
   WHERE id=gid AND workspace_id=w AND book_id=b FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'journal-grant-unavailable' USING ERRCODE='42501';
  END IF;
  reason:=emdo.finance_automation_denial(g,'finance.journals.draft');
  IF reason IS NOT NULL THEN
    RAISE EXCEPTION '%',reason USING ERRCODE='42501';
  END IF;
  IF cap<>'finance.journals.draft'
     OR jsonb_typeof(targets) IS DISTINCT FROM 'array'
     OR jsonb_array_length(targets)<>1
     OR curr IS NULL OR amt IS NULL
     OR jsonb_typeof(journal) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'finance-journal-enqueue-invalid' USING ERRCODE='22023';
  END IF;
  target:=(targets->>0)::uuid;
  IF target IS DISTINCT FROM (journal->>'batchId')::uuid THEN
    RAISE EXCEPTION 'finance-journal-enqueue-target-mismatch' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||b::text,0));
  derived:=emdo.finance_journal_draft_derive(w,b,target);
  canonical_journal:=jsonb_build_object(
    'schemaVersion',1,
    'batchId',target,
    'expectedBatchRevision',(derived->'source'->>'batchRevision')::integer,
    'expectedSnapshotHash',derived->'source'->>'snapshotHash'
  );
  IF journal IS DISTINCT FROM canonical_journal
     OR curr IS DISTINCT FROM derived->>'currency'
     OR amt !~ '^(0|[1-9][0-9]{0,25})(\.[0-9]{1,12})?$'
     OR amt::numeric IS DISTINCT FROM (derived->>'amount')::numeric THEN
    RAISE EXCEPTION 'finance-journal-enqueue-intent-conflict' USING ERRCODE='23514';
  END IF;
  n:=(derived->>'amount')::numeric;
  IF (derived->>'itemCount')::integer>(g.limits->>'maxItemsPerRun')::integer
     OR n>(g.limits->>'maxAmountPerRun')::numeric
     OR curr IS DISTINCT FROM g.limits->>'currency' THEN
    RAISE EXCEPTION 'journal-limit-exceeded' USING ERRCODE='42501';
  END IF;
  review:=jsonb_build_object(
    'itemCount',(derived->>'itemCount')::integer,
    'currency',derived->>'currency',
    'amount',derived->>'amount'
  );
  payload:=jsonb_build_object(
    'workspaceId',w,'bookId',b,'grantId',gid,
    'grantRevision',g.revision,'capability','finance.journals.draft',
    'targets',targets,'currency',derived->>'currency',
    'amount',derived->>'amount','journal',canonical_journal,
    'journalReview',review
  );
  request_hash:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
  SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid;
  IF FOUND THEN
    IF r.workspace_id<>w OR r.book_id<>b OR r.request_hash<>request_hash THEN
      RAISE EXCEPTION 'finance-journal-enqueue-idempotency-conflict' USING ERRCODE='23505';
    END IF;
    RETURN to_jsonb(r)||jsonb_build_object('amount',r.amount::text);
  END IF;
  INSERT INTO emdo.finance_automation_runs(
    id,workspace_id,book_id,grant_id,grant_revision,capability,intent,
    request_hash,item_count,currency,amount
  ) VALUES(
    rid,w,b,gid,g.revision,'finance.journals.draft',payload,request_hash,
    (derived->>'itemCount')::integer,derived->>'currency',n
  ) RETURNING * INTO r;
  RETURN to_jsonb(r)||jsonb_build_object('amount',r.amount::text);
END $$;
ALTER FUNCTION emdo.enqueue_finance_journal_draft_automation(uuid,uuid,uuid,uuid,text,jsonb,text,text,jsonb) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.enqueue_finance_journal_draft_automation(uuid,uuid,uuid,uuid,text,jsonb,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.enqueue_finance_journal_draft_automation(uuid,uuid,uuid,uuid,text,jsonb,text,text,jsonb) TO emdo_app;

--> statement-breakpoint
-- Public result projection.  The immutable proposal and bounded source
-- lineage are exposed, while automation intent and lease data remain private.
CREATE FUNCTION emdo.finance_journal_draft_result_view(w uuid,b uuid,draft_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER STABLE
SET search_path=pg_catalog,emdo SET row_security=on AS $$
  SELECT jsonb_build_object(
    'schemaVersion',r.schema_version,
    'kind','finance-journal-draft',
    'id',r.id,
    'operationId',r.automation_run_id,
    'workspaceId',r.workspace_id,
    'bookId',r.book_id,
    'revision',s.revision,
    'status',s.status,
    'source',r.source,
    'currency',r.currency,
    'itemCount',r.item_count,
    'amount',r.amount::text,
    'proposal',r.proposal,
    'review',CASE WHEN s.review_decision IS NULL THEN NULL::jsonb ELSE jsonb_build_object(
      'decision',s.review_decision,
      'reason',s.review_reason,
      'actorId',s.review_actor_id,
      'at',s.review_at
    ) END,
    'postedJournalIds',s.posted_journal_ids,
    'posting',CASE WHEN s.status='posted' THEN 'performed' ELSE 'not-performed' END,
    'events',coalesce((
      SELECT jsonb_agg(e.event ORDER BY e.revision)
      FROM emdo.finance_automation_journal_draft_events e
      WHERE e.workspace_id=r.workspace_id AND e.book_id=r.book_id
        AND e.draft_id=r.id
    ),'[]'::jsonb)
  )
  FROM emdo.finance_automation_journal_draft_results r
  JOIN emdo.finance_automation_journal_draft_states s
    ON s.workspace_id=r.workspace_id AND s.book_id=r.book_id AND s.draft_id=r.id
  WHERE r.workspace_id=w AND r.book_id=b AND r.id=$3;
$$;
ALTER FUNCTION emdo.finance_journal_draft_result_view(uuid,uuid,uuid) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.finance_journal_draft_result_view(uuid,uuid,uuid) FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow;

CREATE FUNCTION emdo.read_finance_journal_draft_result(w uuid,b uuid,draft_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,emdo SET row_security=on AS $$
BEGIN
  IF draft_id IS NULL THEN
    RAISE EXCEPTION 'finance-journal-draft-invalid' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM emdo.finance_automation_authority_epochs
   WHERE workspace_id=w FOR SHARE;
  IF NOT emdo.finance_book_access(w,b) THEN
    RAISE EXCEPTION 'finance-journal-draft-forbidden' USING ERRCODE='42501';
  END IF;
  RETURN emdo.finance_journal_draft_result_view(w,b,draft_id);
END $$;
ALTER FUNCTION emdo.read_finance_journal_draft_result(uuid,uuid,uuid) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.read_finance_journal_draft_result(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.read_finance_journal_draft_result(uuid,uuid,uuid) TO emdo_app;

CREATE FUNCTION emdo.list_finance_journal_draft_results(w uuid,b uuid,start_offset integer,page_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE items jsonb; total integer;
BEGIN
  IF start_offset IS NULL OR start_offset<0 OR start_offset>1000000
     OR page_limit IS NULL OR page_limit<1 OR page_limit>100 THEN
    RAISE EXCEPTION 'finance-journal-draft-invalid-page' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM emdo.finance_automation_authority_epochs
   WHERE workspace_id=w FOR SHARE;
  IF NOT emdo.finance_book_access(w,b) THEN
    RAISE EXCEPTION 'finance-journal-draft-forbidden' USING ERRCODE='42501';
  END IF;
  SELECT count(*)::integer INTO total
    FROM emdo.finance_automation_journal_draft_results r
   WHERE r.workspace_id=w AND r.book_id=b;
  SELECT coalesce(jsonb_agg(v.result ORDER BY p.created_at DESC,p.id DESC),'[]'::jsonb)
    INTO items
    FROM (
      SELECT r.id,r.created_at
        FROM emdo.finance_automation_journal_draft_results r
       WHERE r.workspace_id=w AND r.book_id=b
       ORDER BY r.created_at DESC,r.id DESC
       OFFSET start_offset LIMIT page_limit
    ) p
    CROSS JOIN LATERAL (
      SELECT emdo.finance_journal_draft_result_view(w,b,p.id) AS result
    ) v;
  RETURN jsonb_build_object(
    'items',items,'offset',start_offset,'limit',page_limit,'total',total
  );
END $$;
ALTER FUNCTION emdo.list_finance_journal_draft_results(uuid,uuid,integer,integer) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.list_finance_journal_draft_results(uuid,uuid,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.list_finance_journal_draft_results(uuid,uuid,integer,integer) TO emdo_app;

-- Command receipts are written by these SECURITY DEFINER functions under the
-- automation executor identity.  The receipt payload is still scoped to the
-- authenticated user through current_user_id().
GRANT SELECT,INSERT ON emdo.finance_command_receipts TO emdo_finance_automation_executor;
CREATE POLICY journal_draft_receipt_executor ON emdo.finance_command_receipts
  FOR ALL TO emdo_finance_automation_executor USING(true) WITH CHECK(true);

CREATE FUNCTION emdo.review_finance_journal_draft(
  w uuid,b uuid,p_draft_id uuid,k text,expected_revision integer,decision text,reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE
  s emdo.finance_automation_journal_draft_states;
  r emdo.finance_automation_journal_draft_results;
  receipt emdo.finance_command_receipts;
  payload_hash text;
  derived jsonb;
  result jsonb;
  p_review_reason text;
  at_time timestamptz;
BEGIN
  p_review_reason:=CASE WHEN reason IS NULL THEN NULL ELSE btrim(reason) END;
  IF p_draft_id IS NULL OR k IS NULL OR k !~ '^[A-Za-z0-9:._-]{1,128}$'
     OR expected_revision IS NULL OR expected_revision<0
     OR decision NOT IN ('approved','rejected')
     OR (p_review_reason IS NOT NULL AND (length(p_review_reason)<3 OR length(p_review_reason)>500)) THEN
    RAISE EXCEPTION 'finance-journal-draft-review-invalid' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM emdo.finance_automation_authority_epochs
   WHERE workspace_id=w FOR UPDATE;
  IF NOT emdo.finance_book_access(w,b,ARRAY['administrator','approver']) THEN
    RAISE EXCEPTION 'finance-journal-draft-review-forbidden' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||b::text,0));
  payload_hash:=encode(sha256(convert_to(jsonb_build_object(
    'draftId',p_draft_id,'expectedRevision',expected_revision,
    'decision',decision,'reason',p_review_reason
  )::text,'UTF8')),'hex');
  SELECT * INTO receipt FROM emdo.finance_command_receipts
   WHERE workspace_id=w AND user_id=emdo.current_user_id() AND idempotency_key=k;
  IF FOUND THEN
    IF receipt.operation<>'automation.journal.review'
       OR receipt.payload_hash<>payload_hash THEN
      RAISE EXCEPTION 'finance-journal-draft-review-idempotency-conflict' USING ERRCODE='23505';
    END IF;
    RETURN receipt.result;
  END IF;
  SELECT * INTO s
    FROM emdo.finance_automation_journal_draft_states
   WHERE workspace_id=w AND book_id=b AND draft_id=p_draft_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finance-journal-draft-not-found' USING ERRCODE='22023';
  END IF;
  IF s.revision<>expected_revision THEN
    RAISE EXCEPTION 'finance-journal-draft-revision-conflict' USING ERRCODE='23514';
  END IF;
  IF s.status NOT IN ('review_required','approved','rejected') THEN
    RAISE EXCEPTION 'finance-journal-draft-review-state-conflict' USING ERRCODE='23514';
  END IF;
  IF decision='approved' THEN
    SELECT * INTO r
      FROM emdo.finance_automation_journal_draft_results
     WHERE workspace_id=w AND book_id=b AND id=p_draft_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'finance-journal-draft-not-found' USING ERRCODE='22023';
    END IF;
    derived:=emdo.finance_journal_draft_derive(w,b,r.source_batch_id);
    IF derived->'source'->>'snapshotHash' IS DISTINCT FROM r.source_snapshot_hash
       OR derived->'proposal' IS DISTINCT FROM r.proposal
       OR (derived->>'itemCount')::integer<>r.item_count
       OR derived->>'currency' IS DISTINCT FROM r.currency
       OR (derived->>'amount')::numeric IS DISTINCT FROM r.amount THEN
      RAISE EXCEPTION 'finance-journal-draft-source-conflict' USING ERRCODE='23514';
    END IF;
  END IF;
  at_time:=clock_timestamp();
  UPDATE emdo.finance_automation_journal_draft_states
     SET revision=revision+1,status=decision,review_decision=decision,
         review_reason=p_review_reason,review_actor_id=emdo.current_user_id(),
         review_at=at_time,updated_at=at_time
   WHERE workspace_id=w AND book_id=b AND draft_id=p_draft_id;
  INSERT INTO emdo.finance_automation_journal_draft_events(
    workspace_id,book_id,draft_id,revision,kind,event,actor_id,created_at
  ) VALUES (
    w,b,p_draft_id,expected_revision+1,'reviewed',jsonb_build_object(
      'kind','reviewed','revision',expected_revision+1,'decision',decision,
      'reason',p_review_reason,'actorId',emdo.current_user_id(),'at',at_time
    ),emdo.current_user_id(),at_time
  );
  result:=emdo.finance_journal_draft_result_view(w,b,p_draft_id);
  INSERT INTO emdo.finance_command_receipts(
    workspace_id,user_id,idempotency_key,operation,payload_hash,result
  ) VALUES (
    w,emdo.current_user_id(),k,'automation.journal.review',payload_hash,result
  );
  RETURN result;
END $$;
ALTER FUNCTION emdo.review_finance_journal_draft(uuid,uuid,uuid,text,integer,text,text) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.review_finance_journal_draft(uuid,uuid,uuid,text,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.review_finance_journal_draft(uuid,uuid,uuid,text,integer,text,text) TO emdo_app;

CREATE FUNCTION emdo.discard_finance_journal_draft(
  w uuid,b uuid,p_draft_id uuid,k text,expected_revision integer,reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE
  s emdo.finance_automation_journal_draft_states;
  receipt emdo.finance_command_receipts;
  payload_hash text;
  result jsonb;
  discard_reason text;
  at_time timestamptz;
BEGIN
  discard_reason:=CASE WHEN reason IS NULL THEN NULL ELSE btrim(reason) END;
  IF p_draft_id IS NULL OR k IS NULL OR k !~ '^[A-Za-z0-9:._-]{1,128}$'
     OR expected_revision IS NULL OR expected_revision<0
     OR discard_reason IS NULL OR length(discard_reason)<3 OR length(discard_reason)>500 THEN
    RAISE EXCEPTION 'finance-journal-draft-discard-invalid' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM emdo.finance_automation_authority_epochs
   WHERE workspace_id=w FOR UPDATE;
  IF NOT emdo.finance_book_access(w,b,ARRAY['administrator','preparer','approver']) THEN
    RAISE EXCEPTION 'finance-journal-draft-discard-forbidden' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||b::text,0));
  payload_hash:=encode(sha256(convert_to(jsonb_build_object(
    'draftId',p_draft_id,'expectedRevision',expected_revision,
    'reason',discard_reason
  )::text,'UTF8')),'hex');
  SELECT * INTO receipt FROM emdo.finance_command_receipts
   WHERE workspace_id=w AND user_id=emdo.current_user_id() AND idempotency_key=k;
  IF FOUND THEN
    IF receipt.operation<>'automation.journal.discard'
       OR receipt.payload_hash<>payload_hash THEN
      RAISE EXCEPTION 'finance-journal-draft-discard-idempotency-conflict' USING ERRCODE='23505';
    END IF;
    RETURN receipt.result;
  END IF;
  SELECT * INTO s
    FROM emdo.finance_automation_journal_draft_states
   WHERE workspace_id=w AND book_id=b AND draft_id=p_draft_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finance-journal-draft-not-found' USING ERRCODE='22023';
  END IF;
  IF s.revision<>expected_revision THEN
    RAISE EXCEPTION 'finance-journal-draft-revision-conflict' USING ERRCODE='23514';
  END IF;
  IF s.status NOT IN ('review_required','approved','rejected') THEN
    RAISE EXCEPTION 'finance-journal-draft-discard-state-conflict' USING ERRCODE='23514';
  END IF;
  at_time:=clock_timestamp();
  -- Existing review provenance is retained; an unreviewed draft remains
  -- review-null and is represented by the discard event itself.
  UPDATE emdo.finance_automation_journal_draft_states
     SET revision=revision+1,status='discarded',updated_at=at_time
   WHERE workspace_id=w AND book_id=b AND draft_id=p_draft_id;
  INSERT INTO emdo.finance_automation_journal_draft_events(
    workspace_id,book_id,draft_id,revision,kind,event,actor_id,created_at
  ) VALUES (
    w,b,p_draft_id,expected_revision+1,'discarded',jsonb_build_object(
      'kind','discarded','revision',expected_revision+1,'reason',discard_reason,
      'actorId',emdo.current_user_id(),'at',at_time
    ),emdo.current_user_id(),at_time
  );
  result:=emdo.finance_journal_draft_result_view(w,b,p_draft_id);
  INSERT INTO emdo.finance_command_receipts(
    workspace_id,user_id,idempotency_key,operation,payload_hash,result
  ) VALUES (
    w,emdo.current_user_id(),k,'automation.journal.discard',payload_hash,result
  );
  RETURN result;
END $$;
ALTER FUNCTION emdo.discard_finance_journal_draft(uuid,uuid,uuid,text,integer,text) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.discard_finance_journal_draft(uuid,uuid,uuid,text,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.discard_finance_journal_draft(uuid,uuid,uuid,text,integer,text) TO emdo_app;

-- Posting is deliberately split.  This lock RPC revalidates the complete
-- immutable source/proposal, then the app's canonical import transaction posts
-- it; complete_finance_journal_draft_post records the resulting journal IDs.
CREATE FUNCTION emdo.lock_finance_journal_draft_post(w uuid,b uuid,p_draft_id uuid,expected_revision integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE
  s emdo.finance_automation_journal_draft_states;
  r emdo.finance_automation_journal_draft_results;
  derived jsonb;
BEGIN
  IF p_draft_id IS NULL OR expected_revision IS NULL OR expected_revision<0 THEN
    RAISE EXCEPTION 'finance-journal-draft-post-invalid' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM emdo.finance_automation_authority_epochs
   WHERE workspace_id=w FOR UPDATE;
  IF NOT emdo.finance_book_access(w,b,ARRAY['administrator','approver']) THEN
    RAISE EXCEPTION 'finance-journal-draft-post-forbidden' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||b::text,0));
  SELECT * INTO s
    FROM emdo.finance_automation_journal_draft_states
   WHERE workspace_id=w AND book_id=b AND draft_id=p_draft_id
   FOR UPDATE;
  SELECT * INTO r
    FROM emdo.finance_automation_journal_draft_results
   WHERE workspace_id=w AND book_id=b AND id=p_draft_id
   ;
  IF NOT FOUND OR s.draft_id IS NULL THEN
    RAISE EXCEPTION 'finance-journal-draft-not-found' USING ERRCODE='22023';
  END IF;
  IF s.revision<>expected_revision OR s.status<>'approved' THEN
    RAISE EXCEPTION 'finance-journal-draft-post-state-conflict' USING ERRCODE='23514';
  END IF;
  derived:=emdo.finance_journal_draft_derive(w,b,r.source_batch_id);
  IF derived->'source'->>'snapshotHash' IS DISTINCT FROM r.source_snapshot_hash
     OR derived->'proposal' IS DISTINCT FROM r.proposal
     OR (derived->>'itemCount')::integer<>r.item_count
     OR derived->>'currency' IS DISTINCT FROM r.currency
     OR (derived->>'amount')::numeric IS DISTINCT FROM r.amount THEN
    RAISE EXCEPTION 'finance-journal-draft-source-conflict' USING ERRCODE='23514';
  END IF;
  RETURN jsonb_build_object(
    'batchId',r.source_batch_id,
    'batchRevision',r.source_batch_revision
  );
END $$;
ALTER FUNCTION emdo.lock_finance_journal_draft_post(uuid,uuid,uuid,integer) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.lock_finance_journal_draft_post(uuid,uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.lock_finance_journal_draft_post(uuid,uuid,uuid,integer) TO emdo_app;

CREATE FUNCTION emdo.complete_finance_journal_draft_post(
  w uuid,b uuid,p_draft_id uuid,expected_revision integer,journal_ids jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE
  s emdo.finance_automation_journal_draft_states;
  r emdo.finance_automation_journal_draft_results;
  source_batch emdo.finance_normalized_imports;
  expected_journal jsonb;
  expected_lines jsonb;
  matched boolean;
  matched_journal_id uuid;
  matched_journal_ids uuid[]:=ARRAY[]::uuid[];
  journal_text text;
  at_time timestamptz;
  result jsonb;
BEGIN
  IF p_draft_id IS NULL OR expected_revision IS NULL OR expected_revision<0
     OR jsonb_typeof(journal_ids) IS DISTINCT FROM 'array'
     OR jsonb_array_length(journal_ids)<1 OR jsonb_array_length(journal_ids)>10000 THEN
    RAISE EXCEPTION 'finance-journal-draft-post-invalid' USING ERRCODE='22023';
  END IF;
  IF (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(journal_ids))
       <>jsonb_array_length(journal_ids)
     OR EXISTS (
       SELECT FROM jsonb_array_elements_text(journal_ids) x
       WHERE x.value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     ) THEN
    RAISE EXCEPTION 'finance-journal-draft-post-identities-invalid' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM emdo.finance_automation_authority_epochs
   WHERE workspace_id=w FOR UPDATE;
  IF NOT emdo.finance_book_access(w,b,ARRAY['administrator','approver']) THEN
    RAISE EXCEPTION 'finance-journal-draft-post-forbidden' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||b::text,0));
  SELECT * INTO s
    FROM emdo.finance_automation_journal_draft_states
   WHERE workspace_id=w AND book_id=b AND draft_id=p_draft_id
   FOR UPDATE;
  SELECT * INTO r
    FROM emdo.finance_automation_journal_draft_results
   WHERE workspace_id=w AND book_id=b AND id=p_draft_id;
  IF NOT FOUND OR s.draft_id IS NULL THEN
    RAISE EXCEPTION 'finance-journal-draft-not-found' USING ERRCODE='22023';
  END IF;
  IF s.revision<>expected_revision OR s.status<>'approved' THEN
    RAISE EXCEPTION 'finance-journal-draft-post-state-conflict' USING ERRCODE='23514';
  END IF;
  SELECT * INTO source_batch
    FROM emdo.finance_normalized_imports i
   WHERE i.workspace_id=w AND i.book_id=b AND i.id=r.source_batch_id;
  IF NOT FOUND OR source_batch.status<>'committed'
     OR source_batch.revision<>r.source_batch_revision+1 THEN
    RAISE EXCEPTION 'finance-journal-draft-source-not-committed' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
       SELECT FROM jsonb_array_elements_text(journal_ids) x
       WHERE NOT EXISTS (
         SELECT FROM emdo.finance_economic_transactions t
         JOIN emdo.finance_normalized_import_rows nr
           ON nr.workspace_id=t.workspace_id AND nr.book_id=t.book_id
          AND nr.economic_transaction_id=t.id
         WHERE t.workspace_id=w AND t.book_id=b AND nr.batch_id=r.source_batch_id
           AND t.journal_id=x.value::uuid
       )
     ) THEN
    RAISE EXCEPTION 'finance-journal-draft-post-source-link-conflict' USING ERRCODE='23514';
  END IF;
  -- Every saved journal proposal must have an exact posted line signature in
  -- the canonical import output.  Extra IDs for already committed/ignored
  -- source rows are permitted, but an unrelated journal cannot satisfy a draft.
  FOR expected_journal IN
    SELECT value FROM jsonb_array_elements(r.proposal->'journals')
  LOOP
    expected_lines:=expected_journal->'lines';
    SELECT actual.id INTO matched_journal_id
    FROM (
      SELECT j.id,j.effective_on,j.description,j.source_reference,
             jsonb_agg(jsonb_build_object(
               'accountId',l.account_id,
               'side',l.side,
               'amount',trim_scale(l.amount)::text,
               'currency',l.currency,
               'nativeAmount',trim_scale(l.native_amount)::text,
               'fxRate',trim_scale(l.fx_rate)::text,
               'fxSource',l.fx_source,
               'description',l.description
             ) ORDER BY l.line_number) AS lines
      FROM emdo.finance_journals j
      JOIN emdo.finance_journal_lines l
        ON l.workspace_id=j.workspace_id AND l.book_id=j.book_id
       AND l.journal_id=j.id
      WHERE j.workspace_id=w AND j.book_id=b AND j.status='posted'
        AND j.id IN (SELECT value::uuid FROM jsonb_array_elements_text(journal_ids))
      GROUP BY j.id,j.effective_on,j.description,j.source_reference
    ) actual
    WHERE actual.effective_on=(expected_journal->>'effectiveOn')::date
      AND actual.description=expected_journal->>'description'
      AND actual.source_reference=expected_journal->>'sourceReference'
      AND actual.lines IS NOT DISTINCT FROM expected_lines
      AND NOT (actual.id=ANY(matched_journal_ids))
    ORDER BY actual.id
    LIMIT 1;
    matched:=FOUND;
    IF NOT matched THEN
      RAISE EXCEPTION 'finance-journal-draft-post-proposal-conflict' USING ERRCODE='23514';
    END IF;
    matched_journal_ids:=array_append(matched_journal_ids,matched_journal_id);
    -- Consume one actual identity per proposal journal so duplicate
    -- signatures cannot be satisfied by the same posted journal.
  END LOOP;
  at_time:=clock_timestamp();
  UPDATE emdo.finance_automation_journal_draft_states
     SET revision=revision+1,status='posted',posted_journal_ids=journal_ids,
         updated_at=at_time
   WHERE workspace_id=w AND book_id=b AND draft_id=p_draft_id;
  INSERT INTO emdo.finance_automation_journal_draft_events(
    workspace_id,book_id,draft_id,revision,kind,event,actor_id,created_at
  ) VALUES (
    w,b,p_draft_id,expected_revision+1,'posted',jsonb_build_object(
      'kind','posted','revision',expected_revision+1,'journalIds',journal_ids,
      'actorId',emdo.current_user_id(),'at',at_time
    ),emdo.current_user_id(),at_time
  );
  result:=emdo.finance_journal_draft_result_view(w,b,p_draft_id);
  RETURN result;
END $$;
ALTER FUNCTION emdo.complete_finance_journal_draft_post(uuid,uuid,uuid,integer,jsonb) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.complete_finance_journal_draft_post(uuid,uuid,uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.complete_finance_journal_draft_post(uuid,uuid,uuid,integer,jsonb) TO emdo_app;

--> statement-breakpoint
-- The worker is given only the run identity, CAS revision and lease token.
-- The canonical run intent and all source/review facts are reloaded here.
CREATE FUNCTION emdo.generate_finance_journal_draft(
  rid uuid,expected_revision integer,token uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE
  r emdo.finance_automation_runs;
  g emdo.finance_automation_grants;
  result_id uuid;
  existing_id uuid;
  derived jsonb;
  review jsonb;
  canonical_journal jsonb;
  reason text;
  n numeric;
  payload jsonb;
BEGIN
  IF rid IS NULL OR token IS NULL OR expected_revision IS NULL OR expected_revision<1 THEN
    RAISE EXCEPTION 'finance-journal-invalid-lease' USING ERRCODE='22023';
  END IF;
  SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finance-journal-run-unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM emdo.finance_automation_authority_epochs
   WHERE workspace_id=r.workspace_id FOR UPDATE;
  SELECT * INTO g FROM emdo.finance_automation_grants
   WHERE id=r.grant_id AND workspace_id=r.workspace_id AND book_id=r.book_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finance-journal-grant-unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid FOR UPDATE;
  reason:=emdo.finance_automation_denial(g,r.capability);
  IF reason IS NOT NULL OR r.grant_revision<>g.revision THEN
    RAISE EXCEPTION 'finance-journal-authority-revoked' USING ERRCODE='42501';
  END IF;
  SELECT id INTO existing_id
    FROM emdo.finance_automation_journal_draft_results
   WHERE automation_run_id=rid AND workspace_id=r.workspace_id AND book_id=r.book_id;
  IF FOUND THEN
    IF r.status='completed' AND r.outcome_reference=existing_id
       AND r.lease_token=token AND r.revision=expected_revision+1 THEN
      RETURN existing_id;
    END IF;
    RAISE EXCEPTION 'finance-journal-result-conflict' USING ERRCODE='23514';
  END IF;
  IF r.status<>'executing' OR r.revision<>expected_revision
     OR r.lease_token IS DISTINCT FROM token
     OR r.lease_expires_at<=clock_timestamp() OR NOT r.reserved THEN
    RAISE EXCEPTION 'finance-journal-lease-conflict' USING ERRCODE='42501';
  END IF;
  IF r.capability<>'finance.journals.draft'
     OR r.intent->>'workspaceId' IS DISTINCT FROM r.workspace_id::text
     OR r.intent->>'bookId' IS DISTINCT FROM r.book_id::text
     OR r.intent->>'grantId' IS DISTINCT FROM r.grant_id::text
     OR (r.intent->>'grantRevision')::integer IS DISTINCT FROM g.revision
     OR r.intent->>'capability' IS DISTINCT FROM r.capability
     OR NOT emdo.jsonb_object_has_exact_keys(
       r.intent,ARRAY['workspaceId','bookId','grantId','grantRevision',
                     'capability','targets','currency','amount','journal',
                     'journalReview']
     ) THEN
    RAISE EXCEPTION 'finance-journal-intent-invalid' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(r.intent->'targets') IS DISTINCT FROM 'array'
     OR jsonb_array_length(r.intent->'targets')<>1
     OR jsonb_typeof(r.intent->'journal') IS DISTINCT FROM 'object'
     OR jsonb_typeof(r.intent->'journalReview') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'finance-journal-intent-invalid' USING ERRCODE='22023';
  END IF;
  IF (r.intent->'targets'->>0)::uuid IS DISTINCT FROM (r.intent->'journal'->>'batchId')::uuid THEN
    RAISE EXCEPTION 'finance-journal-target-conflict' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(r.workspace_id::text||':'||r.book_id::text,0));
  derived:=emdo.finance_journal_draft_derive(
    r.workspace_id,r.book_id,(r.intent->'journal'->>'batchId')::uuid
  );
  canonical_journal:=jsonb_build_object(
    'schemaVersion',1,
    'batchId',derived->'source'->>'batchId',
    'expectedBatchRevision',(derived->'source'->>'batchRevision')::integer,
    'expectedSnapshotHash',derived->'source'->>'snapshotHash'
  );
  review:=jsonb_build_object(
    'itemCount',(derived->>'itemCount')::integer,
    'currency',derived->>'currency',
    'amount',derived->>'amount'
  );
  IF r.intent->'journal' IS DISTINCT FROM canonical_journal
     OR r.intent->'journalReview' IS DISTINCT FROM review
     OR r.item_count<>(derived->>'itemCount')::integer
     OR r.currency IS DISTINCT FROM derived->>'currency'
     OR r.amount IS DISTINCT FROM (derived->>'amount')::numeric
     OR r.intent->>'currency' IS DISTINCT FROM derived->>'currency'
     OR r.intent->>'amount' IS DISTINCT FROM derived->>'amount'
     OR r.intent->>'targets' IS NULL
     OR r.request_hash IS DISTINCT FROM encode(sha256(convert_to(r.intent::text,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'finance-journal-intent-conflict' USING ERRCODE='23514';
  END IF;
  n:=(derived->>'amount')::numeric;
  IF (derived->>'itemCount')::integer>(g.limits->>'maxItemsPerRun')::integer
     OR n>(g.limits->>'maxAmountPerRun')::numeric
     OR derived->>'currency' IS DISTINCT FROM g.limits->>'currency' THEN
    RAISE EXCEPTION 'finance-journal-limit-exceeded' USING ERRCODE='42501';
  END IF;
  IF EXISTS (
    SELECT FROM emdo.finance_automation_runs x
     WHERE x.grant_id=g.id AND x.reserved
     HAVING count(*)>(g.limits->>'maxRuns')::integer
        OR coalesce(sum(x.item_count),0)>(g.limits->>'maxTotalItems')::integer
        OR coalesce(sum(x.amount),0)>(g.limits->>'maxTotalAmount')::numeric
  ) OR EXISTS (
    SELECT FROM emdo.workspace_entitlements e
     WHERE e.workspace_id=r.workspace_id AND e.capability='finance.automations.run'
       AND e."limit" IS NOT NULL
       AND (SELECT count(*) FROM emdo.finance_automation_runs x
             WHERE x.workspace_id=r.workspace_id AND x.reserved)>e."limit"
  ) THEN
    RAISE EXCEPTION 'finance-journal-limit-exceeded' USING ERRCODE='42501';
  END IF;
  result_id:=gen_random_uuid();
  payload:=jsonb_build_object(
    'schemaVersion',1,'kind','finance-journal-draft','id',result_id,
    'operationId',r.id,'workspaceId',r.workspace_id,'bookId',r.book_id,
    'revision',0,'status','review_required','source',derived->'source',
    'currency',derived->>'currency','itemCount',(derived->>'itemCount')::integer,
    'amount',derived->>'amount','proposal',derived->'proposal','review',NULL,
    'postedJournalIds','[]'::jsonb,'posting','not-performed','events','[]'::jsonb
  );
  IF octet_length((payload->'source')::text)>8000000
     OR octet_length((payload->'proposal')::text)>8000000 THEN
    RAISE EXCEPTION 'finance-journal-source-limit' USING ERRCODE='54000';
  END IF;
  INSERT INTO emdo.finance_automation_journal_draft_results(
    id,workspace_id,book_id,automation_run_id,schema_version,
    source_batch_id,source_batch_revision,source_snapshot_hash,source_evidence_id,
    source_digest,source_mapping_hash,currency,item_count,amount,source,proposal
  ) VALUES (
    result_id,r.workspace_id,r.book_id,r.id,1,
    (derived->'source'->>'batchId')::uuid,
    (derived->'source'->>'batchRevision')::integer,
    derived->'source'->>'snapshotHash',
    (derived->'source'->>'evidenceId')::uuid,
    derived->'source'->>'sourceDigest',
    derived->'source'->>'mappingHash',
    derived->>'currency',(derived->>'itemCount')::integer,
    n,derived->'source',derived->'proposal'
  );
  INSERT INTO emdo.finance_automation_journal_draft_states(
    workspace_id,book_id,draft_id,revision,status,posted_journal_ids
  ) VALUES (r.workspace_id,r.book_id,result_id,0,'review_required','[]'::jsonb);
  UPDATE emdo.finance_automation_runs
     SET status='completed',outcome_reference=result_id,revision=revision+1
   WHERE id=rid;
  RETURN result_id;
END $$;
ALTER FUNCTION emdo.generate_finance_journal_draft(uuid,integer,uuid) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.generate_finance_journal_draft(uuid,integer,uuid) FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow;
GRANT EXECUTE ON FUNCTION emdo.generate_finance_journal_draft(uuid,integer,uuid) TO emdo_worker,emdo_worker_executor;
