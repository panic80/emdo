-- One account/private-source opening proof architecture. The initial posting command
-- consumes reviewed legacy snapshots; future assignment sources must supply an equally
-- authoritative reviewed amount source before a new source_kind is enabled.
CREATE TABLE emdo.finance_opening_proofs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, book_id uuid NOT NULL,
 financial_account_id uuid NOT NULL, source_space_id uuid NOT NULL, source_owner_user_id uuid NOT NULL,
 source_kind text NOT NULL CHECK(source_kind='legacy-migration'), migration_id uuid NOT NULL,
 source_record_id uuid NOT NULL, source_revision integer NOT NULL CHECK(source_revision>0),
 source_snapshot_hash text NOT NULL CHECK(source_snapshot_hash ~ '^[a-f0-9]{64}$'),
 review_id uuid NOT NULL, evidence_id uuid NOT NULL, evidence_digest text NOT NULL CHECK(evidence_digest ~ '^[a-f0-9]{64}$'),
 effective_on date NOT NULL, amount_cad_minor numeric(20,0) NOT NULL CHECK(amount_cad_minor<>0 AND abs(amount_cad_minor)<=9007199254740991),
 ledger_account_id uuid NOT NULL, counterpart_ledger_account_id uuid NOT NULL,
 journal_id uuid NOT NULL, idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 posted_by uuid NOT NULL REFERENCES emdo.auth_users(id), posted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 supersedes_proof_id uuid REFERENCES emdo.finance_opening_proofs(id),
 CONSTRAINT finance_opening_scope UNIQUE(workspace_id,book_id,id),
 CONSTRAINT finance_opening_key UNIQUE(workspace_id,book_id,idempotency_key),
 CONSTRAINT finance_opening_journal UNIQUE(workspace_id,book_id,journal_id),
 CONSTRAINT finance_opening_account_fk FOREIGN KEY(workspace_id,book_id,financial_account_id) REFERENCES emdo.finance_financial_accounts(workspace_id,book_id,id),
 CONSTRAINT finance_opening_journal_fk FOREIGN KEY(workspace_id,book_id,journal_id) REFERENCES emdo.finance_journals(workspace_id,book_id,id),
 CONSTRAINT finance_opening_record_fk FOREIGN KEY(workspace_id,book_id,migration_id,source_record_id) REFERENCES emdo.finance_legacy_migration_records(workspace_id,book_id,migration_id,id),
 CONSTRAINT finance_opening_evidence_fk FOREIGN KEY(workspace_id,book_id,evidence_id) REFERENCES emdo.finance_book_evidence(workspace_id,book_id,id),
 CONSTRAINT finance_opening_review_fk FOREIGN KEY(review_id) REFERENCES emdo.finance_legacy_migration_reviews(id)
);
CREATE INDEX finance_opening_account ON emdo.finance_opening_proofs(workspace_id,book_id,financial_account_id,posted_at);
ALTER TABLE emdo.finance_opening_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_opening_proofs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON emdo.finance_opening_proofs FROM PUBLIC,emdo_worker,emdo_workflow;
GRANT SELECT,INSERT ON emdo.finance_opening_proofs TO emdo_app;
GRANT SELECT ON emdo.finance_opening_proofs TO emdo_policy_reader;
CREATE POLICY opening_policy_reader ON emdo.finance_opening_proofs FOR SELECT TO emdo_policy_reader USING(true);
CREATE POLICY opening_read ON emdo.finance_opening_proofs FOR SELECT TO emdo_app USING(emdo.finance_legacy_migration_access(workspace_id,book_id,workspace_id,source_space_id,source_owner_user_id));
CREATE POLICY opening_insert ON emdo.finance_opening_proofs FOR INSERT TO emdo_app WITH CHECK(emdo.finance_legacy_migration_access(workspace_id,book_id,workspace_id,source_space_id,source_owner_user_id,ARRAY['administrator','approver']));
CREATE TRIGGER opening_immutable BEFORE UPDATE OR DELETE ON emdo.finance_opening_proofs FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_legacy_migration_history_mutation();
--> statement-breakpoint
CREATE FUNCTION emdo.legacy_opening_binding(w uuid,b uuid,m uuid,xid uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE r emdo.finance_legacy_migration_runs; x emdo.finance_legacy_migration_records; a emdo.finance_financial_accounts; v emdo.finance_legacy_migration_reviews; o jsonb; ev text; amount numeric;
BEGIN
 SELECT * INTO r FROM emdo.finance_legacy_migration_runs WHERE workspace_id=w AND book_id=b AND id=m;
 IF NOT FOUND OR emdo.finance_legacy_migration_access(w,b,w,r.source_space_id,r.source_owner_user_id,ARRAY['administrator','approver']) IS NOT TRUE THEN RAISE EXCEPTION 'opening-forbidden' USING ERRCODE='42501'; END IF;
 PERFORM emdo.lock_legacy_finance_source(w,r.source_space_id,r.source_owner_user_id);
 IF NOT emdo.lock_finance_book_grant(w,b) THEN RAISE EXCEPTION 'opening-forbidden' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||b::text,0));
 SELECT * INTO r FROM emdo.finance_legacy_migration_runs WHERE workspace_id=w AND book_id=b AND id=m FOR SHARE;
 SELECT * INTO x FROM emdo.finance_legacy_migration_records WHERE workspace_id=w AND book_id=b AND migration_id=m AND id=xid FOR SHARE;
 IF NOT FOUND OR x.entity_type<>'finance.account' OR x.tombstoned THEN RAISE EXCEPTION 'opening-account-required' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM emdo.sync_entities s WHERE s.id=x.legacy_row_id AND s.household_id=w AND s.space_id=r.source_space_id AND s.original_owner_user_id=r.source_owner_user_id AND s.revision=x.source_revision AND s.payload=x.payload AND s.tombstoned_at IS NULL) THEN RAISE EXCEPTION 'opening-source-changed' USING ERRCODE='23514'; END IF;
 SELECT value INTO o FROM jsonb_array_elements(r.mapping->'openings') WHERE value->>'legacyAccountId'=x.entity_id;
 SELECT * INTO v FROM emdo.finance_legacy_migration_reviews WHERE workspace_id=w AND book_id=b AND migration_id=m AND record_id=xid ORDER BY revision DESC LIMIT 1;
 IF o IS NULL OR o->>'disposition'<>'explicit-opening' OR o->>'openingEffectiveOn' IS NULL OR v.id IS NULL OR v.revision>x.revision OR v.decision->>'targetFinancialAccountId' IS DISTINCT FROM x.target_financial_account_id::text OR v.decision->>'openingDisposition'<>'explicit-opening' OR v.decision->>'classificationConfirmed'<>'true' OR v.decision->>'openingEffectiveOn' IS DISTINCT FROM o->>'openingEffectiveOn' OR v.decision->>'openingLedgerAccountId' IS DISTINCT FROM o->>'targetLedgerAccountId' OR v.decision->>'openingEvidenceId' IS DISTINCT FROM o->>'targetEvidenceId' THEN RAISE EXCEPTION 'opening-reviewed-mapping-required' USING ERRCODE='23514'; END IF;
 SELECT * INTO a FROM emdo.finance_financial_accounts WHERE workspace_id=w AND book_id=b AND id=x.target_financial_account_id AND active;
 IF NOT FOUND OR a.currency<>'CAD' OR NOT EXISTS(SELECT 1 FROM emdo.finance_books WHERE workspace_id=w AND id=b AND functional_currency='CAD') THEN RAISE EXCEPTION 'opening-cad-account-required' USING ERRCODE='23514'; END IF;
 IF a.ledger_account_id=(o->>'targetLedgerAccountId')::uuid OR NOT EXISTS(SELECT 1 FROM emdo.finance_ledger_accounts WHERE workspace_id=w AND book_id=b AND id=(o->>'targetLedgerAccountId')::uuid AND active) THEN RAISE EXCEPTION 'opening-counterpart-required' USING ERRCODE='23514'; END IF;
 SELECT plaintext_sha256 INTO ev FROM emdo.finance_book_evidence WHERE workspace_id=w AND book_id=b AND id=(o->>'targetEvidenceId')::uuid;
 IF ev IS NULL THEN RAISE EXCEPTION 'opening-evidence-required' USING ERRCODE='23514'; END IF;
 amount:=(x.payload->>'openingBalanceCadMinor')::numeric;
 IF amount IS NULL OR amount=0 OR amount<>trunc(amount) OR abs(amount)>9007199254740991 THEN RAISE EXCEPTION 'opening-nonzero-exact-amount-required' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('sourceSpaceId',r.source_space_id,'sourceOwnerUserId',r.source_owner_user_id,'financialAccountId',a.id,'sourceRevision',x.source_revision,'sourceSnapshotHash',r.source_snapshot_hash,'recordRevision',x.revision,'runRevision',r.revision,'reviewId',v.id,'evidenceId',o->>'targetEvidenceId','evidenceDigest',ev,'effectiveOn',o->>'openingEffectiveOn','amountCadMinor',amount::text,'ledgerAccountId',a.ledger_account_id,'counterpartLedgerAccountId',o->>'targetLedgerAccountId');
END $$;
REVOKE ALL ON FUNCTION emdo.legacy_opening_binding(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.legacy_opening_binding(uuid,uuid,uuid,uuid) TO emdo_app;
--> statement-breakpoint
CREATE FUNCTION emdo.guard_finance_opening_proof() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE v jsonb; prior emdo.finance_opening_proofs; amount numeric;
BEGIN
 v:=emdo.legacy_opening_binding(NEW.workspace_id,NEW.book_id,NEW.migration_id,NEW.source_record_id);
 IF NEW.request_hash IS DISTINCT FROM encode(sha256(convert_to(jsonb_build_array(NEW.migration_id,NEW.source_record_id,(v->>'runRevision')::integer,(v->>'recordRevision')::integer,v->>'sourceSnapshotHash')::text,'UTF8')),'hex') THEN RAISE EXCEPTION 'opening-request-binding-mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.source_space_id::text IS DISTINCT FROM v->>'sourceSpaceId' OR NEW.source_owner_user_id::text IS DISTINCT FROM v->>'sourceOwnerUserId' OR NEW.financial_account_id::text IS DISTINCT FROM v->>'financialAccountId' OR NEW.source_revision IS DISTINCT FROM (v->>'sourceRevision')::integer OR NEW.source_snapshot_hash IS DISTINCT FROM v->>'sourceSnapshotHash' OR NEW.review_id::text IS DISTINCT FROM v->>'reviewId' OR NEW.evidence_id::text IS DISTINCT FROM v->>'evidenceId' OR NEW.evidence_digest IS DISTINCT FROM v->>'evidenceDigest' OR NEW.effective_on IS DISTINCT FROM (v->>'effectiveOn')::date OR NEW.amount_cad_minor IS DISTINCT FROM (v->>'amountCadMinor')::numeric OR NEW.ledger_account_id::text IS DISTINCT FROM v->>'ledgerAccountId' OR NEW.counterpart_ledger_account_id::text IS DISTINCT FROM v->>'counterpartLedgerAccountId' THEN RAISE EXCEPTION 'opening-proof-binding-mismatch' USING ERRCODE='23514'; END IF;
 SELECT * INTO prior FROM emdo.finance_opening_proofs WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND financial_account_id=NEW.financial_account_id ORDER BY posted_at DESC,id DESC LIMIT 1;
 IF prior.id IS NOT NULL AND (NEW.supersedes_proof_id IS DISTINCT FROM prior.id OR prior.source_space_id<>NEW.source_space_id OR prior.source_owner_user_id<>NEW.source_owner_user_id OR NOT EXISTS(SELECT 1 FROM emdo.finance_journals WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND reversal_of=prior.journal_id AND status='posted')) THEN RAISE EXCEPTION 'opening-existing-proof-requires-reversal' USING ERRCODE='23514'; END IF;
 IF prior.id IS NULL AND NEW.supersedes_proof_id IS NOT NULL THEN RAISE EXCEPTION 'opening-invalid-supersession' USING ERRCODE='23514'; END IF;
 amount:=abs(NEW.amount_cad_minor)/100;
 IF NOT EXISTS(SELECT 1 FROM emdo.finance_journals j WHERE j.workspace_id=NEW.workspace_id AND j.book_id=NEW.book_id AND j.id=NEW.journal_id AND j.status='posted' AND j.effective_on=NEW.effective_on AND j.reversal_of IS NULL AND j.source_reference='opening:'||NEW.migration_id::text||':'||NEW.source_record_id::text AND j.idempotency_key='opening:'||NEW.idempotency_key AND j.payload_hash=NEW.request_hash AND NOT EXISTS(SELECT 1 FROM emdo.finance_journals WHERE reversal_of=j.id)) OR EXISTS(SELECT 1 FROM emdo.finance_economic_transactions WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND journal_id=NEW.journal_id) OR (SELECT count(*) FROM emdo.finance_journal_lines WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND journal_id=NEW.journal_id)<>2 OR NOT EXISTS(SELECT 1 FROM emdo.finance_journal_lines l WHERE l.journal_id=NEW.journal_id AND l.account_id=NEW.ledger_account_id AND l.side=CASE WHEN NEW.amount_cad_minor>0 THEN 'debit' ELSE 'credit' END AND l.amount=abs(NEW.amount_cad_minor)/100 AND l.native_amount=l.amount AND l.currency='CAD' AND l.fx_rate=1) THEN RAISE EXCEPTION 'opening-posted-journal-required' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM emdo.finance_journal_lines l WHERE l.journal_id=NEW.journal_id AND l.account_id=NEW.counterpart_ledger_account_id AND l.side=CASE WHEN NEW.amount_cad_minor>0 THEN 'credit' ELSE 'debit' END AND l.amount=abs(NEW.amount_cad_minor)/100 AND l.native_amount=l.amount AND l.currency='CAD' AND l.fx_rate=1) THEN RAISE EXCEPTION 'opening-counterpart-posting-required' USING ERRCODE='23514'; END IF;
 NEW.posted_by:=emdo.current_user_id(); NEW.posted_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER finance_opening_proof_guard BEFORE INSERT ON emdo.finance_opening_proofs FOR EACH ROW EXECUTE FUNCTION emdo.guard_finance_opening_proof();
REVOKE ALL ON FUNCTION emdo.guard_finance_opening_proof() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION emdo.post_legacy_finance_opening(w uuid,b uuid,m uuid,x uuid,run_revision integer,record_revision integer,source_hash text,ikey text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE v jsonb; proof emdo.finance_opening_proofs; prior emdo.finance_opening_proofs; jid uuid; pid uuid; reqhash text; amount numeric;
BEGIN
 v:=emdo.legacy_opening_binding(w,b,m,x);
 reqhash:=encode(sha256(convert_to(jsonb_build_array(m,x,run_revision,record_revision,source_hash)::text,'UTF8')),'hex');
 SELECT * INTO proof FROM emdo.finance_opening_proofs WHERE workspace_id=w AND book_id=b AND idempotency_key=ikey;
 IF FOUND THEN IF EXISTS(SELECT 1 FROM emdo.finance_journals WHERE workspace_id=w AND book_id=b AND reversal_of=proof.journal_id AND status='posted') THEN RAISE EXCEPTION 'opening-reversed-replay-requires-new-key' USING ERRCODE='23514'; END IF; IF proof.request_hash<>reqhash THEN RAISE EXCEPTION 'opening-idempotency-conflict' USING ERRCODE='23514'; END IF; RETURN to_jsonb(proof); END IF;
 IF (v->>'runRevision')::integer<>run_revision OR (v->>'recordRevision')::integer<>record_revision OR v->>'sourceSnapshotHash'<>source_hash THEN RAISE EXCEPTION 'opening-source-revision-conflict' USING ERRCODE='23514'; END IF;
 SELECT id INTO pid FROM emdo.finance_periods WHERE workspace_id=w AND book_id=b AND status='open' AND (v->>'effectiveOn')::date BETWEEN starts_on AND ends_on FOR SHARE;
 IF pid IS NULL THEN RAISE EXCEPTION 'finance-open-period-required' USING ERRCODE='23514'; END IF;
 SELECT * INTO prior FROM emdo.finance_opening_proofs WHERE workspace_id=w AND book_id=b AND financial_account_id=(v->>'financialAccountId')::uuid ORDER BY posted_at DESC,id DESC LIMIT 1;
 IF prior.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM emdo.finance_journals WHERE workspace_id=w AND book_id=b AND reversal_of=prior.journal_id AND status='posted') THEN RAISE EXCEPTION 'opening-existing-proof-requires-reversal' USING ERRCODE='23514'; END IF;
 jid:=gen_random_uuid(); amount:=abs((v->>'amountCadMinor')::numeric)/100;
 INSERT INTO emdo.finance_journals(id,workspace_id,book_id,effective_on,description,source_reference,period_id,idempotency_key,payload_hash,created_by) VALUES(jid,w,b,(v->>'effectiveOn')::date,'Reviewed account opening','opening:'||m::text||':'||x::text,pid,'opening:'||ikey,reqhash,emdo.current_user_id());
 INSERT INTO emdo.finance_journal_lines(workspace_id,book_id,journal_id,account_id,line_number,side,amount,currency,native_amount,fx_rate,fx_source) VALUES(w,b,jid,(v->>'ledgerAccountId')::uuid,1,CASE WHEN (v->>'amountCadMinor')::numeric>0 THEN 'debit' ELSE 'credit' END,amount,'CAD',amount,1,'identity'),(w,b,jid,(v->>'counterpartLedgerAccountId')::uuid,2,CASE WHEN (v->>'amountCadMinor')::numeric>0 THEN 'credit' ELSE 'debit' END,amount,'CAD',amount,1,'identity');
 UPDATE emdo.finance_journals SET status='posted',posted_at=clock_timestamp() WHERE workspace_id=w AND book_id=b AND id=jid;
 INSERT INTO emdo.finance_opening_proofs(workspace_id,book_id,financial_account_id,source_space_id,source_owner_user_id,source_kind,migration_id,source_record_id,source_revision,source_snapshot_hash,review_id,evidence_id,evidence_digest,effective_on,amount_cad_minor,ledger_account_id,counterpart_ledger_account_id,journal_id,idempotency_key,request_hash,posted_by,supersedes_proof_id) VALUES(w,b,(v->>'financialAccountId')::uuid,(v->>'sourceSpaceId')::uuid,(v->>'sourceOwnerUserId')::uuid,'legacy-migration',m,x,(v->>'sourceRevision')::integer,source_hash,(v->>'reviewId')::uuid,(v->>'evidenceId')::uuid,v->>'evidenceDigest',(v->>'effectiveOn')::date,(v->>'amountCadMinor')::numeric,(v->>'ledgerAccountId')::uuid,(v->>'counterpartLedgerAccountId')::uuid,jid,ikey,reqhash,emdo.current_user_id(),prior.id) RETURNING * INTO proof;
 RETURN to_jsonb(proof);
END $$;
REVOKE ALL ON FUNCTION emdo.post_legacy_finance_opening(uuid,uuid,uuid,uuid,integer,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.post_legacy_finance_opening(uuid,uuid,uuid,uuid,integer,integer,text,text) TO emdo_app;

--> statement-breakpoint
CREATE FUNCTION emdo.finance_account_opening_proof(w uuid,b uuid,a uuid,s uuid,o uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE p emdo.finance_opening_proofs;
BEGIN
 IF emdo.finance_legacy_migration_access(w,b,w,s,o) IS NOT TRUE THEN RAISE EXCEPTION 'opening-forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO p FROM emdo.finance_opening_proofs WHERE workspace_id=w AND book_id=b AND financial_account_id=a AND source_space_id=s AND source_owner_user_id=o ORDER BY posted_at DESC,id DESC LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM emdo.finance_journals WHERE workspace_id=w AND book_id=b AND reversal_of=p.journal_id AND status='posted') OR NOT EXISTS(SELECT 1 FROM emdo.finance_journals WHERE workspace_id=w AND book_id=b AND id=p.journal_id AND status='posted') THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM emdo.finance_legacy_migration_records x JOIN emdo.finance_legacy_migration_runs r ON r.workspace_id=x.workspace_id AND r.book_id=x.book_id AND r.id=x.migration_id JOIN emdo.finance_legacy_migration_reviews v ON v.id=p.review_id AND v.workspace_id=x.workspace_id AND v.record_id=x.id AND v.revision<=x.revision WHERE x.workspace_id=w AND x.book_id=b AND x.id=p.source_record_id AND x.migration_id=p.migration_id AND NOT EXISTS(SELECT 1 FROM emdo.finance_legacy_migration_reviews newer WHERE newer.workspace_id=w AND newer.record_id=x.id AND newer.revision>v.revision) AND x.source_revision=p.source_revision AND r.source_snapshot_hash=p.source_snapshot_hash AND x.target_financial_account_id=a AND (x.payload->>'openingBalanceCadMinor')::numeric=p.amount_cad_minor AND NOT x.tombstoned AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.mapping->'openings') op WHERE op->>'legacyAccountId'=x.entity_id AND op->>'disposition'='explicit-opening' AND (op->>'openingEffectiveOn')::date=p.effective_on AND op->>'targetEvidenceId'=p.evidence_id::text AND op->>'targetLedgerAccountId'=p.counterpart_ledger_account_id::text)) THEN RETURN NULL; END IF;
 RETURN to_jsonb(p);
END $$;
ALTER FUNCTION emdo.finance_account_opening_proof(uuid,uuid,uuid,uuid,uuid) OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.finance_account_opening_proof(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.finance_account_opening_proof(uuid,uuid,uuid,uuid,uuid) TO emdo_app,emdo_policy_reader;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.legacy_finance_activation_readiness(w uuid,m uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE r emdo.finance_legacy_migration_runs; source_data jsonb; target_data jsonb;
BEGIN
 SELECT * INTO r FROM emdo.finance_legacy_migration_runs WHERE workspace_id=w AND id=m;
 IF NOT FOUND OR emdo.finance_legacy_migration_access(w,r.book_id,w,r.source_space_id,r.source_owner_user_id,ARRAY['administrator','approver']) IS NOT TRUE THEN RAISE EXCEPTION 'legacy-activation-forbidden' USING ERRCODE='42501'; END IF;
 -- Source first, book second. Writers take the same source lock before mutation.
 PERFORM emdo.lock_legacy_finance_source(w,r.source_space_id,r.source_owner_user_id);
 IF NOT emdo.lock_finance_book_grant(w,r.book_id) THEN RAISE EXCEPTION 'legacy-activation-forbidden' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||r.book_id::text,0));
 SELECT * INTO r FROM emdo.finance_legacy_migration_runs WHERE workspace_id=w AND id=m;
 IF r.status<>'cutover-approved' OR NOT EXISTS(SELECT 1 FROM emdo.finance_legacy_migration_cutovers c JOIN emdo.finance_legacy_migration_comparisons p ON p.workspace_id=c.workspace_id AND p.migration_id=c.migration_id AND p.id=c.comparison_id WHERE c.workspace_id=w AND c.migration_id=m AND c.source_snapshot_hash=r.source_snapshot_hash AND p.source_snapshot_hash=r.source_snapshot_hash AND p.status='passed') THEN RAISE EXCEPTION 'legacy-activation-approval-required' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM emdo.finance_legacy_migration_records x WHERE x.workspace_id=w AND x.migration_id=m AND (x.candidate_status='blocked' OR x.disposition='unresolved' OR (x.disposition='backfill' AND x.backfill_state<>'backfilled'))) THEN RAISE EXCEPTION 'legacy-activation-unresolved' USING ERRCODE='23514'; END IF;
 -- The current source must be exactly the reviewed archival snapshot, not a stale digest supplied by a caller.
 IF EXISTS(
  SELECT 1 FROM emdo.sync_entities s FULL JOIN (SELECT * FROM emdo.finance_legacy_migration_records WHERE workspace_id=w AND migration_id=m) x ON x.legacy_row_id=s.id
  WHERE (x.id IS NOT NULL OR (s.household_id=w AND s.space_id=r.source_space_id AND s.original_owner_user_id=r.source_owner_user_id AND s.entity_type IN ('finance.account','finance.transaction','finance.category','finance.budget','finance.bill','finance.subscription','finance.goal')))
  AND (x.id IS NULL OR s.id IS NULL OR s.household_id IS DISTINCT FROM w OR s.space_id IS DISTINCT FROM r.source_space_id OR s.original_owner_user_id IS DISTINCT FROM r.source_owner_user_id OR s.entity_type IS DISTINCT FROM x.entity_type OR s.entity_id IS DISTINCT FROM x.entity_id OR s.revision IS DISTINCT FROM x.source_revision OR s.payload IS DISTINCT FROM x.payload OR (s.tombstoned_at IS NOT NULL) IS DISTINCT FROM x.tombstoned)
 ) THEN RAISE EXCEPTION 'legacy-activation-source-changed' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM emdo.finance_legacy_migration_records x WHERE x.workspace_id=w AND x.migration_id=m AND x.entity_type='finance.account' AND NOT x.tombstoned AND (x.payload->>'openingBalanceCadMinor') IS DISTINCT FROM '0' AND emdo.finance_account_opening_proof(w,r.book_id,x.target_financial_account_id,r.source_space_id,r.source_owner_user_id) IS NULL) THEN RAISE EXCEPTION 'legacy-activation-opening-posting-required' USING ERRCODE='23514'; END IF;
 -- One normalized account belongs to one private legacy source. Do not expose another source's transactions.
 IF EXISTS(SELECT 1 FROM emdo.finance_legacy_migration_records x JOIN emdo.finance_legacy_migration_records y ON y.workspace_id=x.workspace_id AND y.book_id=x.book_id AND y.target_financial_account_id=x.target_financial_account_id AND y.entity_type='finance.account' JOIN emdo.finance_legacy_activations a ON a.workspace_id=y.workspace_id AND a.migration_id=y.migration_id WHERE x.workspace_id=w AND x.migration_id=m AND x.entity_type='finance.account' AND y.migration_id<>m) OR EXISTS(SELECT 1 FROM emdo.finance_legacy_migration_records x WHERE x.workspace_id=w AND x.migration_id=m AND x.entity_type='finance.account' AND NOT x.tombstoned GROUP BY x.target_financial_account_id HAVING count(*)<>1) THEN RAISE EXCEPTION 'legacy-activation-account-shared' USING ERRCODE='23514'; END IF;
 IF EXISTS(
  SELECT 1 FROM emdo.finance_legacy_migration_records x
  LEFT JOIN emdo.finance_normalized_import_rows n ON n.workspace_id=x.workspace_id AND n.book_id=x.book_id AND n.id=x.target_row_id
  LEFT JOIN emdo.finance_normalized_imports b ON b.workspace_id=n.workspace_id AND b.book_id=n.book_id AND b.id=n.batch_id
  LEFT JOIN emdo.finance_financial_accounts a ON a.workspace_id=b.workspace_id AND a.book_id=b.book_id AND a.id=b.financial_account_id
  LEFT JOIN emdo.finance_economic_transactions e ON e.workspace_id=n.workspace_id AND e.book_id=n.book_id AND e.id=n.economic_transaction_id
  LEFT JOIN emdo.finance_journals j ON j.workspace_id=e.workspace_id AND j.book_id=e.book_id AND j.id=e.journal_id
  WHERE x.workspace_id=w AND x.migration_id=m AND x.entity_type='finance.transaction' AND NOT x.tombstoned
  AND (n.id IS NULL OR b.status IS DISTINCT FROM 'committed' OR n.status NOT IN ('committed','matched') OR e.id IS NULL OR j.status IS DISTINCT FROM 'posted'
   OR n.native_amount IS DISTINCT FROM x.native_amount OR e.native_amount IS DISTINCT FROM x.native_amount OR a.currency IS DISTINCT FROM x.currency
   OR b.financial_account_id IS DISTINCT FROM x.target_financial_account_id OR e.financial_account_id IS DISTINCT FROM x.target_financial_account_id
   OR n.effective_on::text IS DISTINCT FROM x.payload->>'postedOn' OR e.effective_on IS DISTINCT FROM n.effective_on OR n.description IS DISTINCT FROM x.payload->>'description' OR e.description IS DISTINCT FROM n.description
   OR n.source_facts#>'{legacyMigration,provenance}' IS DISTINCT FROM x.provenance
   OR n.external_id IS DISTINCT FROM x.external_id OR n.source_facts#>>'{legacyMigration,payloadHash}' IS DISTINCT FROM x.payload_hash
   OR NOT EXISTS(SELECT 1 FROM emdo.finance_import_row_reviews v WHERE v.workspace_id=n.workspace_id AND v.book_id=n.book_id AND v.row_id=n.id AND v.revision=n.revision))
 ) THEN RAISE EXCEPTION 'legacy-activation-posted-target-required' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM emdo.finance_legacy_migration_records a JOIN emdo.finance_economic_transactions e ON e.workspace_id=a.workspace_id AND e.book_id=a.book_id AND e.financial_account_id=a.target_financial_account_id WHERE a.workspace_id=w AND a.migration_id=m AND a.entity_type='finance.account' AND NOT a.tombstoned AND NOT EXISTS(SELECT 1 FROM emdo.finance_legacy_migration_records x JOIN emdo.finance_normalized_import_rows n ON n.workspace_id=x.workspace_id AND n.book_id=x.book_id AND n.id=x.target_row_id WHERE x.workspace_id=w AND x.migration_id=m AND NOT x.tombstoned AND n.economic_transaction_id=e.id)) THEN RAISE EXCEPTION 'legacy-activation-account-existing-unmapped-transactions' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM emdo.finance_legacy_migration_records x JOIN emdo.finance_normalized_import_rows n ON n.workspace_id=x.workspace_id AND n.book_id=x.book_id AND n.id=x.target_row_id WHERE x.workspace_id=w AND x.migration_id=m AND x.entity_type='finance.transaction' AND NOT x.tombstoned GROUP BY n.economic_transaction_id HAVING count(*)>1) THEN RAISE EXCEPTION 'legacy-activation-duplicate-target' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_array(x.legacy_row_id,x.entity_type,x.entity_id,x.source_revision,x.payload,x.tombstoned) ORDER BY x.entity_type,x.entity_id),'[]'::jsonb) INTO source_data FROM emdo.finance_legacy_migration_records x WHERE x.workspace_id=w AND x.migration_id=m;
 SELECT coalesce(jsonb_agg(jsonb_build_array(x.target_row_id,n.revision,n.status,e.id,e.journal_id,e.native_amount::text,e.description,e.effective_on,e.fingerprint) ORDER BY x.entity_id),'[]'::jsonb) INTO target_data FROM emdo.finance_legacy_migration_records x JOIN emdo.finance_normalized_import_rows n ON n.workspace_id=x.workspace_id AND n.book_id=x.book_id AND n.id=x.target_row_id JOIN emdo.finance_economic_transactions e ON e.workspace_id=n.workspace_id AND e.book_id=n.book_id AND e.id=n.economic_transaction_id WHERE x.workspace_id=w AND x.migration_id=m AND x.entity_type='finance.transaction' AND NOT x.tombstoned;
 SELECT target_data || coalesce(jsonb_agg(jsonb_build_array(p.id,p.journal_id,p.amount_cad_minor::text,p.review_id,p.evidence_digest) ORDER BY p.id),'[]'::jsonb) INTO target_data FROM emdo.finance_opening_proofs p WHERE p.workspace_id=w AND p.migration_id=m AND NOT EXISTS(SELECT 1 FROM emdo.finance_journals WHERE workspace_id=w AND book_id=r.book_id AND reversal_of=p.journal_id AND status='posted');
 RETURN jsonb_build_object('sourceHash',emdo.canonical_json_hash(source_data),'targetHash',emdo.canonical_json_hash(target_data),'bookId',r.book_id,'sourceSpaceId',r.source_space_id,'sourceOwnerUserId',r.source_owner_user_id);
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.resolve_legacy_finance_route(w uuid,s uuid,o uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE a emdo.finance_legacy_activations;
BEGIN
 IF o IS DISTINCT FROM emdo.current_user_id() OR emdo.is_active_request_scope(w,s,NULL) IS NOT TRUE THEN RAISE EXCEPTION 'legacy-route-private-scope-forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM emdo.finance_legacy_activations WHERE workspace_id=w AND source_space_id=s AND source_owner_user_id=o;
 IF NOT FOUND THEN RETURN '{"kind":"legacy"}'::jsonb; END IF;
 IF emdo.finance_legacy_migration_access(w,a.book_id,w,s,o) IS NOT TRUE THEN RAISE EXCEPTION 'legacy-route-target-forbidden' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM emdo.finance_legacy_migration_records x WHERE x.workspace_id=w AND x.migration_id=a.migration_id AND x.entity_type='finance.account' AND NOT x.tombstoned AND (x.payload->>'openingBalanceCadMinor') IS DISTINCT FROM '0' AND emdo.finance_account_opening_proof(w,a.book_id,x.target_financial_account_id,s,o) IS NULL) THEN RAISE EXCEPTION 'legacy-route-opening-proof-invalid' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('kind','normalized','migrationId',a.migration_id,'bookId',a.book_id,'activatedAt',a.activated_at);
END $$;
--> statement-breakpoint
CREATE FUNCTION emdo.reject_opening_economic_transaction() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,emdo SET row_security=on AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM emdo.finance_opening_proofs WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND journal_id=NEW.journal_id) THEN RAISE EXCEPTION 'opening-economic-double-count-forbidden' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION emdo.reject_opening_economic_transaction() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.reject_opening_economic_transaction() FROM PUBLIC;
CREATE TRIGGER reject_opening_economic_transaction BEFORE INSERT OR UPDATE ON emdo.finance_economic_transactions FOR EACH ROW EXECUTE FUNCTION emdo.reject_opening_economic_transaction();
