-- Durable source-only workload authority. No browser session is minted for a worker.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='emdo_finance_standardization_executor') THEN CREATE ROLE emdo_finance_standardization_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='emdo_finance_standardization_executor' AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolcreatedb)) OR EXISTS(SELECT FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='emdo_finance_standardization_executor') OR roleid=(SELECT oid FROM pg_roles WHERE rolname='emdo_finance_standardization_executor')) THEN RAISE EXCEPTION 'unsafe standardization executor'; END IF;
END $$;
GRANT USAGE ON SCHEMA emdo TO emdo_finance_standardization_executor;
GRANT EXECUTE ON FUNCTION emdo.current_user_id(),emdo.finance_book_access(uuid,uuid,text[]),emdo.lock_finance_book_grant(uuid,uuid) TO emdo_finance_standardization_executor;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['finance_standardization_runs','finance_standardization_extractions','finance_standardization_spend','finance_standardization_configuration'] LOOP
 EXECUTE format('ALTER TABLE emdo.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE emdo.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON emdo.%I FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow,emdo_worker_executor,emdo_worker_dispatch_executor',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON emdo.%I TO emdo_finance_standardization_executor',t);
 EXECUTE format('CREATE POLICY standardization_executor ON emdo.%I TO emdo_finance_standardization_executor USING(true) WITH CHECK(true)',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['household_memberships','auth_users','finance_book_grants','workspace_entitlements','finance_automation_authority_epochs','finance_book_evidence','finance_books'] LOOP
 EXECUTE format('GRANT SELECT ON emdo.%I TO emdo_finance_standardization_executor',t);
 EXECUTE format('CREATE POLICY standardization_authority_read ON emdo.%I FOR SELECT TO emdo_finance_standardization_executor USING(true)',t);
 END LOOP;
END $$;
REVOKE INSERT,UPDATE ON emdo.finance_standardization_configuration FROM emdo_finance_standardization_executor;
INSERT INTO emdo.finance_standardization_configuration(id) VALUES('v1');
GRANT SELECT,INSERT ON emdo.finance_command_receipts TO emdo_finance_standardization_executor;
CREATE POLICY standardization_receipt ON emdo.finance_command_receipts TO emdo_finance_standardization_executor USING(user_id=emdo.current_user_id()) WITH CHECK(user_id=emdo.current_user_id());

CREATE FUNCTION emdo.standardization_denial(r emdo.finance_standardization_runs) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
 IF r.authorization_expires_at<=clock_timestamp() THEN RETURN 'The saved analysis authorization expired.'; END IF;
 IF NOT EXISTS(SELECT FROM emdo.household_memberships m JOIN emdo.auth_users u ON u.id=m.user_id WHERE m.household_id=r.workspace_id AND m.user_id=r.authorized_by AND m.status='active' AND u.email_verified) THEN RETURN 'The authorizing membership is no longer active.'; END IF;
 IF NOT EXISTS(SELECT FROM emdo.finance_book_grants WHERE workspace_id=r.workspace_id AND book_id=r.book_id AND user_id=r.authorized_by AND revoked_at IS NULL AND role IN ('administrator','preparer','approver')) THEN RETURN 'The authorizing book access was revoked.'; END IF;
 IF NOT EXISTS(SELECT FROM emdo.finance_automation_authority_epochs WHERE workspace_id=r.workspace_id AND revision=r.authority_epoch) THEN RETURN 'Workspace authorization changed. This analysis cannot continue.'; END IF;
 IF NOT EXISTS(SELECT FROM emdo.workspace_entitlements WHERE workspace_id=r.workspace_id AND capability='finance.standardizations.run' AND enabled) THEN RETURN 'Saved standardization is not enabled for this workspace.'; END IF;
 IF NOT EXISTS(SELECT FROM emdo.finance_standardization_configuration WHERE id='v1' AND ready) THEN RETURN 'Saved standardization is not ready in this environment.'; END IF;
 IF NOT EXISTS(SELECT FROM emdo.finance_book_evidence WHERE workspace_id=r.workspace_id AND book_id=r.book_id AND id=r.evidence_id AND plaintext_sha256=r.source_digest) THEN RETURN 'The original evidence binding changed.'; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION emdo.standardization_app_book(w uuid,b uuid,mutating boolean) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NOT emdo.lock_finance_book_grant(w,b) OR NOT emdo.finance_book_access(w,b,CASE WHEN mutating THEN ARRAY['administrator','preparer','approver'] ELSE ARRAY['administrator','preparer','approver','viewer'] END) THEN RAISE EXCEPTION 'standardization-book-access-denied' USING ERRCODE='42501'; END IF;
END $$;
CREATE FUNCTION emdo.start_finance_standardization(w uuid,b uuid,e uuid,expected_hash text,k text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs; epoch integer; h text; receipt emdo.finance_command_receipts; reason text;
BEGIN
 PERFORM emdo.standardization_app_book(w,b,true);
 IF k !~ '^[a-fA-F0-9-]{36}$' OR expected_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'standardization-invalid-request' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||emdo.current_user_id()::text||':'||k,0));
 h:=encode(sha256(convert_to(jsonb_build_object('bookId',b,'evidenceId',e,'sourceDigest',expected_hash)::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM emdo.finance_command_receipts WHERE workspace_id=w AND user_id=emdo.current_user_id() AND idempotency_key=k;
 IF FOUND THEN IF receipt.operation<>'standardization.start' OR receipt.payload_hash<>h THEN RAISE EXCEPTION 'standardization-idempotency-conflict' USING ERRCODE='23514'; END IF; RETURN receipt.result; END IF;
 SELECT revision INTO epoch FROM emdo.finance_automation_authority_epochs WHERE workspace_id=w FOR UPDATE;
 IF epoch IS NULL OR NOT EXISTS(SELECT FROM emdo.finance_book_evidence WHERE workspace_id=w AND book_id=b AND id=e AND plaintext_sha256=expected_hash) THEN RAISE EXCEPTION 'standardization-source-conflict' USING ERRCODE='23514'; END IF;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE workspace_id=w AND book_id=b AND evidence_id=e AND source_digest=expected_hash AND authorized_by=emdo.current_user_id();
 IF NOT FOUND THEN
 r.id:=gen_random_uuid();r.workspace_id:=w;r.book_id:=b;r.evidence_id:=e;r.source_digest:=expected_hash;r.authorized_by:=emdo.current_user_id();r.authority_epoch:=epoch;r.authorization_expires_at:=clock_timestamp()+interval '7 days';
 reason:=emdo.standardization_denial(r);IF reason IS NOT NULL THEN RAISE EXCEPTION 'standardization-unavailable: %',reason USING ERRCODE='42501'; END IF;
 INSERT INTO emdo.finance_standardization_runs(id,workspace_id,book_id,evidence_id,source_digest,authorized_by,authority_epoch,authorization_expires_at) VALUES(r.id,w,b,e,expected_hash,r.authorized_by,epoch,r.authorization_expires_at) RETURNING * INTO r;
 END IF;
 INSERT INTO emdo.finance_command_receipts(workspace_id,user_id,idempotency_key,operation,payload_hash,result) VALUES(w,emdo.current_user_id(),k,'standardization.start',h,jsonb_build_object('id',r.id));
 RETURN jsonb_build_object('id',r.id);
END $$;
CREATE FUNCTION emdo.read_finance_standardizations(w uuid,b uuid,rid uuid,n integer) RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
 PERFORM emdo.standardization_app_book(w,b,false);
 IF n<0 OR n>1000000 THEN RAISE EXCEPTION 'standardization-invalid-offset' USING ERRCODE='23514'; END IF;
 RETURN QUERY SELECT to_jsonb(r)||jsonb_build_object('filename',e.filename,'format',e.format,'reviewed_mapping',(SELECT jsonb_build_object('mappingId',m.id,'mappingVersion',m.version,'status',m.status) FROM emdo.finance_report_mapping_versions m WHERE m.id=r.reviewed_mapping_id AND m.workspace_id=r.workspace_id AND m.book_id=r.book_id),'can_manage',r.authorized_by=emdo.current_user_id() OR emdo.finance_book_access(w,b,ARRAY['administrator'])) FROM emdo.finance_standardization_runs r JOIN emdo.finance_book_evidence e ON e.id=r.evidence_id AND e.workspace_id=r.workspace_id AND e.book_id=r.book_id WHERE r.workspace_id=w AND r.book_id=b AND (rid IS NULL OR r.id=rid) ORDER BY r.created_at DESC,r.id LIMIT 51 OFFSET n;
END $$;
CREATE FUNCTION emdo.change_finance_standardization(w uuid,b uuid,rid uuid,expected integer,action text,k text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs; h text; receipt emdo.finance_command_receipts; reason text;
BEGIN
 PERFORM emdo.standardization_app_book(w,b,true);
 IF action NOT IN ('retry','cancel') OR k !~ '^[a-fA-F0-9-]{36}$' THEN RAISE EXCEPTION 'standardization-invalid-action' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||emdo.current_user_id()::text||':'||k,0));
 h:=encode(sha256(convert_to(jsonb_build_object('runId',rid,'revision',expected,'action',action)::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM emdo.finance_command_receipts WHERE workspace_id=w AND user_id=emdo.current_user_id() AND idempotency_key=k;
 IF FOUND THEN IF receipt.operation<>'standardization.change' OR receipt.payload_hash<>h THEN RAISE EXCEPTION 'standardization-idempotency-conflict' USING ERRCODE='23514'; END IF;RETURN receipt.result; END IF;
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=w FOR UPDATE;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=rid AND workspace_id=w AND book_id=b FOR UPDATE;
 IF NOT FOUND OR (r.authorized_by<>emdo.current_user_id() AND NOT emdo.finance_book_access(w,b,ARRAY['administrator'])) THEN RAISE EXCEPTION 'standardization-run-access-denied' USING ERRCODE='42501'; END IF;
 IF r.revision<>expected THEN RAISE EXCEPTION 'standardization-revision-conflict' USING ERRCODE='23514'; END IF;
 IF action='cancel' THEN
 IF r.status NOT IN ('queued','extracting','proposing') THEN RAISE EXCEPTION 'standardization-not-cancellable' USING ERRCODE='23514'; END IF;
 UPDATE emdo.finance_standardization_runs SET status='cancelled',revision=revision+1,delivery_pending=false,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=rid;
 ELSE
 reason:=emdo.standardization_denial(r);
 IF r.status<>'blocked' OR r.attempt>=3 OR reason IS NOT NULL OR EXISTS(SELECT FROM emdo.finance_standardization_spend WHERE run_id=rid AND status IN ('reserved','indeterminate')) THEN RAISE EXCEPTION 'standardization-not-retryable' USING ERRCODE='23514'; END IF;
 UPDATE emdo.finance_standardization_runs SET status='queued',revision=revision+1,delivery_revision=delivery_revision+1,delivery_pending=true,delivery_token=NULL,delivery_expires_at=NULL,lease_token=NULL,lease_expires_at=NULL,blockers='[]'::jsonb,updated_at=clock_timestamp() WHERE id=rid;
 END IF;
 INSERT INTO emdo.finance_command_receipts(workspace_id,user_id,idempotency_key,operation,payload_hash,result) VALUES(w,emdo.current_user_id(),k,'standardization.change',h,jsonb_build_object('id',rid));RETURN jsonb_build_object('id',rid);
END $$;
GRANT UPDATE(revision) ON emdo.finance_automation_authority_epochs TO emdo_finance_standardization_executor;
CREATE POLICY standardization_authority_lock ON emdo.finance_automation_authority_epochs FOR UPDATE TO emdo_finance_standardization_executor USING(true) WITH CHECK(true);
CREATE FUNCTION emdo.standardization_worker_identity() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT session_user='emdo_worker_executor_login' AND current_user='emdo_finance_standardization_executor' $$;
CREATE FUNCTION emdo.claim_standardization_deliveries(n integer) RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs; token uuid;
BEGIN
 IF session_user<>'emdo_worker_dispatcher_login' OR n NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'standardization-dispatch-denied' USING ERRCODE='42501'; END IF;
 FOR r IN SELECT * FROM emdo.finance_standardization_runs WHERE status IN ('extracting','proposing') AND lease_expires_at<clock_timestamp() ORDER BY lease_expires_at FOR UPDATE SKIP LOCKED LIMIT n LOOP
 UPDATE emdo.finance_standardization_runs SET status='indeterminate',revision=revision+1,lease_token=NULL,lease_expires_at=NULL,blockers=jsonb_build_array('The execution lease expired. No approval or posting was performed; any model result needs reconciliation.'),updated_at=clock_timestamp() WHERE id=r.id;
 END LOOP;
 FOR r IN SELECT * FROM emdo.finance_standardization_runs WHERE status='queued' AND delivery_pending AND (delivery_expires_at IS NULL OR delivery_expires_at<clock_timestamp()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT n LOOP
 token:=gen_random_uuid();UPDATE emdo.finance_standardization_runs SET delivery_token=token,delivery_expires_at=clock_timestamp()+interval '1 minute' WHERE id=r.id;
 RETURN NEXT jsonb_build_object('runId',r.id,'deliveryRevision',r.delivery_revision,'token',token);
 END LOOP;
END $$;
CREATE FUNCTION emdo.ack_standardization_delivery(rid uuid,drev integer,token uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
 IF session_user<>'emdo_worker_dispatcher_login' THEN RAISE EXCEPTION 'standardization-dispatch-denied' USING ERRCODE='42501'; END IF;
 UPDATE emdo.finance_standardization_runs SET delivery_pending=false WHERE id=rid AND delivery_revision=drev AND delivery_token=token;RETURN FOUND;
END $$;
CREATE FUNCTION emdo.claim_finance_standardization(rid uuid,drev integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs; reason text;
BEGIN
 IF NOT emdo.standardization_worker_identity() THEN RAISE EXCEPTION 'standardization-worker-denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=rid;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','denied'); END IF;
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=r.workspace_id FOR UPDATE;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=rid FOR UPDATE;
 IF r.delivery_revision<>drev OR r.status<>'queued' THEN RETURN jsonb_build_object('status','duplicate'); END IF;
 reason:=emdo.standardization_denial(r);
 IF reason IS NOT NULL THEN UPDATE emdo.finance_standardization_runs SET status='authority-revoked',revision=revision+1,blockers=jsonb_build_array(reason),delivery_pending=false,updated_at=clock_timestamp() WHERE id=rid;RETURN jsonb_build_object('status','denied'); END IF;
 IF r.attempt>=3 THEN RETURN jsonb_build_object('status','denied'); END IF;
 UPDATE emdo.finance_standardization_runs SET status='extracting',revision=revision+1,attempt=attempt+1,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '5 minutes',delivery_pending=false,updated_at=clock_timestamp() WHERE id=rid RETURNING * INTO r;
 RETURN jsonb_build_object('status','claimed','claim',jsonb_build_object('runId',r.id,'workspaceId',r.workspace_id,'bookId',r.book_id,'evidenceId',r.evidence_id,'sourceDigest',r.source_digest,'revision',r.revision,'leaseToken',r.lease_token,'leaseExpiresAt',r.lease_expires_at,'authorizedByUserId',r.authorized_by,'authorizationRevision',jsonb_build_object('membership',r.authority_epoch,'bookAccess',r.authority_epoch,'entitlement',r.authority_epoch)));
END $$;
CREATE FUNCTION emdo.lock_standardization_claim(rid uuid,rev integer,token uuid) RETURNS emdo.finance_standardization_runs LANGUAGE plpgsql SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs;
BEGIN
 IF NOT emdo.standardization_worker_identity() THEN RAISE EXCEPTION 'standardization-worker-denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=rid;
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=r.workspace_id FOR UPDATE;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=rid FOR UPDATE;
 IF NOT FOUND OR r.revision<>rev OR r.lease_token IS DISTINCT FROM token OR r.lease_expires_at<=clock_timestamp() OR r.status NOT IN ('extracting','proposing') OR emdo.standardization_denial(r) IS NOT NULL THEN RAISE EXCEPTION 'standardization-authority-revoked' USING ERRCODE='42501'; END IF;
 RETURN r;
END $$;
CREATE FUNCTION emdo.verify_standardization_claim(rid uuid,rev integer,token uuid,extraction_revision integer,extraction_hash text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$ BEGIN PERFORM emdo.lock_standardization_claim(rid,rev,token);RETURN extraction_revision IS NULL OR EXISTS(SELECT FROM emdo.finance_standardization_extractions WHERE run_id=rid AND revision=extraction_revision AND extraction_digest=extraction_hash);EXCEPTION WHEN insufficient_privilege THEN RETURN false; END $$;
CREATE FUNCTION emdo.read_standardization_original(rid uuid,rev integer,token uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs;
BEGIN
 r:=emdo.lock_standardization_claim(rid,rev,token);
 RETURN (SELECT jsonb_build_object('filename',filename,'format',format,'sourceDigest',plaintext_sha256,'encryptedOriginal',encrypted_original) FROM emdo.finance_book_evidence WHERE id=r.evidence_id AND workspace_id=r.workspace_id AND book_id=r.book_id AND plaintext_sha256=r.source_digest);
END $$;
CREATE FUNCTION emdo.save_standardization_extraction(rid uuid,rev integer,token uuid,summary jsonb,envelope jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs; expected_hash text;
BEGIN
 r:=emdo.lock_standardization_claim(rid,rev,token);
 expected_hash:=encode(sha256(convert_to(envelope->>'factsJson','UTF8')),'hex');
 IF r.status<>'extracting' OR summary->>'sourceDigest' IS DISTINCT FROM r.source_digest OR envelope->>'sourceDigest' IS DISTINCT FROM r.source_digest OR summary->>'extractionDigest' IS DISTINCT FROM expected_hash OR envelope->>'extractionDigest' IS DISTINCT FROM expected_hash OR (summary->>'revision')::integer<>r.attempt OR (envelope->>'revision')::integer<>r.attempt OR summary->>'truncated' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'standardization-extraction-conflict' USING ERRCODE='23514'; END IF;
 INSERT INTO emdo.finance_standardization_extractions(id,run_id,revision,source_digest,extraction_digest,envelope) VALUES(gen_random_uuid(),rid,r.attempt,r.source_digest,expected_hash,envelope);
 UPDATE emdo.finance_standardization_runs SET extraction=summary,status='proposing',updated_at=clock_timestamp() WHERE id=rid;RETURN true;
END $$;
CREATE FUNCTION emdo.reserve_standardization_spend(rid uuid,rev integer,token uuid,key text,input_ceiling integer,output_ceiling integer,estimate integer,pricing text,lineage jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs; cfg emdo.finance_standardization_configuration; existing emdo.finance_standardization_spend; total bigint; result uuid;
BEGIN
 r:=emdo.lock_standardization_claim(rid,rev,token);
 IF lineage->>'orchestrationMode' IS DISTINCT FROM 'registered-workflow' OR lineage->>'promptVersion' IS DISTINCT FROM 'finance-standardization-proposal.v1' OR coalesce(lineage->>'managerInvocationId','') !~ '^[a-f0-9-]{36}$' OR coalesce(lineage->>'financeInvocationId','') !~ '^[a-f0-9-]{36}$' OR lineage->>'managerInvocationId'=lineage->>'financeInvocationId' OR octet_length(lineage::text)>2048 THEN RAISE EXCEPTION 'standardization-lineage-invalid' USING ERRCODE='23514'; END IF;
 IF r.status<>'proposing' THEN RAISE EXCEPTION 'standardization-not-proposing' USING ERRCODE='23514'; END IF;
 SELECT * INTO existing FROM emdo.finance_standardization_spend WHERE run_id=rid AND attempt=r.attempt;
 IF FOUND THEN RAISE EXCEPTION 'standardization-provider-attempt-already-reserved' USING ERRCODE='23514'; END IF;
 SELECT * INTO cfg FROM emdo.finance_standardization_configuration WHERE id='v1';
 PERFORM pg_advisory_xact_lock(hashtextextended('standardization-budget:'||r.workspace_id::text,0));
 SELECT coalesce(sum(CASE WHEN status='not-sent' THEN 0 ELSE greatest(reserved_cad_minor,coalesce(actual_cad_minor,0)) END),0) INTO total FROM emdo.finance_standardization_spend WHERE run_id=rid;
 IF estimate<1 OR total+estimate>cfg.max_run_cad_minor THEN RAISE EXCEPTION 'standardization-run-budget-exhausted' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(CASE WHEN s.status='not-sent' THEN 0 ELSE greatest(s.reserved_cad_minor,coalesce(s.actual_cad_minor,0)) END),0) INTO total FROM emdo.finance_standardization_spend s JOIN emdo.finance_standardization_runs other ON other.id=s.run_id WHERE other.workspace_id=r.workspace_id AND s.created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
 IF total+estimate>cfg.max_workspace_day_cad_minor THEN RAISE EXCEPTION 'standardization-workspace-budget-exhausted' USING ERRCODE='23514'; END IF;
 result:=gen_random_uuid();INSERT INTO emdo.finance_standardization_spend(id,run_id,attempt,request_key,claim_token,claim_revision,pricing_version,lineage,input_token_ceiling,output_token_ceiling,reserved_cad_minor) VALUES(result,rid,r.attempt,key,token,rev,pricing,lineage,input_ceiling,output_ceiling,estimate);RETURN result;
END $$;
CREATE FUNCTION emdo.settle_standardization_spend(rid uuid,rev integer,token uuid,reservation uuid,outcome text,actual integer,response_id text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs;
BEGIN
 -- Costs remain recordable after revocation, but cannot authorize any further work.
 IF NOT emdo.standardization_worker_identity() THEN RAISE EXCEPTION 'standardization-worker-denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=rid FOR UPDATE;
 IF outcome NOT IN ('completed','not-sent','indeterminate') OR (outcome='completed' AND (actual IS NULL OR actual<0 OR length(response_id) NOT BETWEEN 1 AND 200)) THEN RAISE EXCEPTION 'standardization-spend-settlement-conflict' USING ERRCODE='23514'; END IF;
 UPDATE emdo.finance_standardization_spend SET status=outcome,actual_cad_minor=actual,provider_response_id=response_id,settled_at=clock_timestamp() WHERE id=reservation AND run_id=rid AND claim_token=token AND claim_revision=rev AND status='reserved';RETURN FOUND;
END $$;
CREATE FUNCTION emdo.block_finance_standardization(rid uuid,rev integer,token uuid,outcome text,reason text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs;
BEGIN
 IF NOT emdo.standardization_worker_identity() THEN RAISE EXCEPTION 'standardization-worker-denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=rid FOR UPDATE;
 IF r.revision<>rev OR r.lease_token IS DISTINCT FROM token OR r.status NOT IN ('extracting','proposing') THEN RETURN false; END IF;
 IF outcome NOT IN ('blocked','indeterminate','authority-revoked') OR length(reason) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'standardization-invalid-outcome' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM emdo.finance_standardization_spend WHERE run_id=rid AND status IN ('reserved','indeterminate')) THEN outcome:='indeterminate'; END IF;
 UPDATE emdo.finance_standardization_runs SET status=outcome,revision=revision+1,blockers=jsonb_build_array(reason),lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=rid;RETURN true;
END $$;
GRANT SELECT,INSERT ON emdo.finance_report_mapping_versions TO emdo_finance_standardization_executor;
CREATE POLICY standardization_mapping_read ON emdo.finance_report_mapping_versions FOR SELECT TO emdo_finance_standardization_executor USING(true);
CREATE POLICY standardization_mapping_candidate ON emdo.finance_report_mapping_versions FOR INSERT TO emdo_finance_standardization_executor WITH CHECK(status='candidate' AND revision=1 AND proposed_by_model='gpt-6-astra');
CREATE FUNCTION emdo.standardization_candidate_allowed(mid uuid,w uuid,b uuid,e uuid,u uuid) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs;
BEGIN
 IF current_user<>'emdo_finance_standardization_executor' OR session_user<>'emdo_worker_executor_login' THEN RETURN false; END IF;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=mid AND workspace_id=w AND book_id=b AND evidence_id=e AND authorized_by=u AND status='proposing' AND lease_token IS NOT NULL AND lease_expires_at>clock_timestamp();
 RETURN FOUND AND emdo.standardization_denial(r) IS NULL AND EXISTS(SELECT FROM emdo.finance_standardization_extractions WHERE run_id=r.id AND revision=r.attempt AND source_digest=r.source_digest) AND EXISTS(SELECT FROM emdo.finance_standardization_spend WHERE run_id=r.id AND attempt=r.attempt AND status='completed');
END $$;
CREATE FUNCTION emdo.finish_finance_standardization(rid uuid,rev integer,token uuid,result jsonb,candidate jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs; p jsonb; d jsonb; provenance jsonb; mapping_version integer:=1; mapping_id uuid; ex emdo.finance_standardization_extractions;
BEGIN
 r:=emdo.lock_standardization_claim(rid,rev,token);p:=result->'proposal';d:=p->'definition';provenance:=result->'provenance';
 SELECT * INTO ex FROM emdo.finance_standardization_extractions WHERE run_id=rid AND revision=r.attempt;
 IF r.status<>'proposing' OR NOT FOUND OR jsonb_typeof(p)<>'object' OR jsonb_typeof(d)<>'object' OR jsonb_typeof(p->'unresolvedQuestions')<>'array' OR jsonb_array_length(p->'unresolvedQuestions') NOT BETWEEN 1 AND 30 OR provenance->>'controller' IS DISTINCT FROM 'emdo' OR provenance->>'orchestrationMode' IS DISTINCT FROM 'registered-workflow' OR provenance->>'model' IS DISTINCT FROM 'gpt-6-astra' OR NOT EXISTS(SELECT FROM emdo.finance_standardization_spend WHERE run_id=rid AND attempt=r.attempt AND status='completed' AND provider_response_id=provenance->>'providerResponseId' AND lineage->>'managerInvocationId'=provenance->>'managerInvocationId' AND lineage->>'financeInvocationId'=provenance->>'financeInvocationId' AND lineage->>'orchestrationMode'=provenance->>'orchestrationMode' AND lineage->>'promptVersion'=provenance->>'promptVersion') THEN RAISE EXCEPTION 'standardization-proposal-provenance-conflict' USING ERRCODE='23514'; END IF;
 IF candidate IS NOT NULL THEN
 -- Only exact CSV source rows can be materialized without human table selection.
 IF ex.envelope->>'kind'<>'csv-table' OR candidate->'example'->'headers' IS DISTINCT FROM (ex.envelope->>'factsJson')::jsonb->'headers' OR candidate->'example'->'rows' IS DISTINCT FROM (ex.envelope->>'factsJson')::jsonb->'rows' OR candidate->'example'->'headers' IS DISTINCT FROM d->'headers' OR candidate->'example'->>'documentId' IS DISTINCT FROM r.evidence_id::text OR candidate->'example'->'context' IS DISTINCT FROM '{"asOf":null,"currency":null}'::jsonb OR coalesce(d->'pdfSelection','null'::jsonb)<>'null'::jsonb OR coalesce(d->'xlsxSelection','null'::jsonb)<>'null'::jsonb THEN RAISE EXCEPTION 'standardization-example-source-conflict' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(r.workspace_id::text||':'||r.book_id::text,0));
 SELECT coalesce(max(version),0)+1 INTO mapping_version FROM emdo.finance_report_mapping_versions WHERE workspace_id=r.workspace_id AND book_id=r.book_id AND provider_key=d->>'providerKey' AND report_name=d->>'reportName' AND report_type=d->>'reportType';
 mapping_id:=rid;
 INSERT INTO emdo.finance_report_mapping_versions(id,workspace_id,book_id,provider_key,report_name,report_type,layout_version,version,revision,status,definition,rationale,unresolved_questions,example,evidence_id,validation,proposed_by_model,created_by) VALUES(mapping_id,r.workspace_id,r.book_id,d->>'providerKey',d->>'reportName',d->>'reportType',d->>'layoutVersion',mapping_version,1,'candidate',d,p->>'rationale',p->'unresolvedQuestions',candidate->'example',r.evidence_id,candidate->'validation','gpt-6-astra',r.authorized_by);
 END IF;
 UPDATE emdo.finance_standardization_runs SET status='needs-review',revision=revision+1,proposal=jsonb_build_object('mappingId',mapping_id,'mappingVersion',mapping_version,'definition',d,'rationale',p->>'rationale','status','candidate','unresolvedQuestions',p->'unresolvedQuestions'),model_provenance=provenance,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=rid;RETURN true;
END $$;

-- Preserve the original application checks. The only exception is a source-bound
-- candidate INSERT inside the dedicated verified worker function, never UPDATE.

CREATE OR REPLACE FUNCTION emdo.lock_finance_book_mutation() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog SET row_security = on AS $$
DECLARE w uuid; b uuid;
BEGIN
  w := NEW.workspace_id; b := NEW.book_id;
  IF TG_TABLE_NAME='finance_report_mapping_versions' AND TG_OP='INSERT' THEN
    IF emdo.standardization_candidate_allowed(NEW.id,w,b,NEW.evidence_id,NEW.created_by) THEN RETURN NEW; END IF;
  END IF;
  IF NOT emdo.lock_finance_book_grant(w,b) THEN RAISE EXCEPTION 'book access revoked' USING ERRCODE='42501'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.workspace_id,NEW.book_id) IS DISTINCT FROM (OLD.workspace_id,OLD.book_id) THEN
    RAISE EXCEPTION 'finance scope is immutable' USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(w::text || ':' || b::text,0));
  IF NOT emdo.finance_book_access(w,b,ARRAY['administrator','preparer','approver']) THEN
    RAISE EXCEPTION 'finance authority revoked' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION emdo.check_report_mapping_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'candidate' OR NEW.revision<>1 OR (NEW.created_by IS DISTINCT FROM emdo.current_user_id() AND NOT emdo.standardization_candidate_allowed(NEW.id,NEW.workspace_id,NEW.book_id,NEW.evidence_id,NEW.created_by))
      OR NEW.definition->>'providerKey' IS DISTINCT FROM NEW.provider_key OR NEW.definition->>'reportName' IS DISTINCT FROM NEW.report_name
      OR NEW.definition->>'reportType' IS DISTINCT FROM NEW.report_type OR NEW.definition->>'layoutVersion' IS DISTINCT FROM NEW.layout_version
      OR NEW.example->>'documentId' IS DISTINCT FROM NEW.evidence_id::text OR NEW.example->>'providerKey' IS DISTINCT FROM NEW.provider_key
      OR NEW.example->>'reportType' IS DISTINCT FROM NEW.report_type OR jsonb_typeof(NEW.unresolved_questions) IS DISTINCT FROM 'array'
      OR octet_length(NEW.example::text)>8388608 THEN
      RAISE EXCEPTION 'mapping must start as a source-bound candidate' USING ERRCODE='23514'; END IF;
  ELSE
    IF OLD.status='retired' OR NEW.revision<>OLD.revision+1 OR (to_jsonb(NEW)-ARRAY['status','revision']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','revision']) THEN
      RAISE EXCEPTION 'mapping definitions and historical versions are immutable' USING ERRCODE='23514'; END IF;
    IF NEW.status NOT IN ('approved','retired') OR NEW.status=OLD.status OR NOT EXISTS(SELECT 1 FROM emdo.finance_report_mapping_reviews WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND mapping_id=NEW.id AND revision=NEW.revision AND reviewed_by=emdo.current_user_id() AND decision=CASE NEW.status WHEN 'approved' THEN 'approve' ELSE 'retire' END) THEN
      RAISE EXCEPTION 'mapping status requires a matching review decision' USING ERRCODE='23514'; END IF;
    IF NEW.status='approved' AND (NEW.validation->>'status' IS DISTINCT FROM 'normalized' OR NEW.unresolved_questions<>'[]'::jsonb) THEN
      RAISE EXCEPTION 'mapping validation and questions must be resolved before approval' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE p record; BEGIN
 FOR p IN SELECT proc.oid::regprocedure AS signature FROM pg_proc proc JOIN pg_namespace n ON n.oid=proc.pronamespace WHERE n.nspname='emdo' AND (proc.proname LIKE '%standardization%' OR proc.proname='standardization_candidate_allowed') LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO emdo_finance_standardization_executor',p.signature);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow,emdo_worker_executor,emdo_worker_dispatch_executor',p.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION emdo.standardization_candidate_allowed(uuid,uuid,uuid,uuid,uuid) TO emdo_app;
GRANT EXECUTE ON FUNCTION emdo.start_finance_standardization(uuid,uuid,uuid,text,text),emdo.read_finance_standardizations(uuid,uuid,uuid,integer),emdo.change_finance_standardization(uuid,uuid,uuid,integer,text,text) TO emdo_app;
GRANT EXECUTE ON FUNCTION emdo.claim_standardization_deliveries(integer),emdo.ack_standardization_delivery(uuid,integer,uuid) TO emdo_worker_dispatch_executor;
GRANT EXECUTE ON FUNCTION emdo.claim_finance_standardization(uuid,integer),emdo.verify_standardization_claim(uuid,integer,uuid,integer,text),emdo.read_standardization_original(uuid,integer,uuid),emdo.save_standardization_extraction(uuid,integer,uuid,jsonb,jsonb),emdo.reserve_standardization_spend(uuid,integer,uuid,text,integer,integer,integer,text,jsonb),emdo.settle_standardization_spend(uuid,integer,uuid,uuid,text,integer,text),emdo.block_finance_standardization(uuid,integer,uuid,text,text),emdo.finish_finance_standardization(uuid,integer,uuid,jsonb,jsonb) TO emdo_worker_executor;
CREATE FUNCTION emdo.finance_standardization_available(w uuid,b uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
 PERFORM emdo.standardization_app_book(w,b,false);
 RETURN EXISTS(SELECT FROM emdo.finance_standardization_configuration WHERE id='v1' AND ready) AND EXISTS(SELECT FROM emdo.workspace_entitlements WHERE workspace_id=w AND capability='finance.standardizations.run' AND enabled);
END $$;
ALTER FUNCTION emdo.finance_standardization_available(uuid,uuid) OWNER TO emdo_finance_standardization_executor;
REVOKE ALL ON FUNCTION emdo.finance_standardization_available(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.finance_standardization_available(uuid,uuid) TO emdo_app;

CREATE FUNCTION emdo.link_standardization_mapping(w uuid,b uuid,rid uuid,expected integer,mid uuid,k text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs; h text; receipt emdo.finance_command_receipts;
BEGIN
 PERFORM emdo.standardization_app_book(w,b,true);
 IF k !~ '^[a-fA-F0-9-]{36}$' THEN RAISE EXCEPTION 'standardization-invalid-key' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||emdo.current_user_id()::text||':'||k,0));
 h:=encode(sha256(convert_to(jsonb_build_object('runId',rid,'revision',expected,'mappingId',mid)::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM emdo.finance_command_receipts WHERE workspace_id=w AND user_id=emdo.current_user_id() AND idempotency_key=k;
 IF FOUND THEN IF receipt.operation<>'standardization.link-mapping' OR receipt.payload_hash<>h THEN RAISE EXCEPTION 'standardization-idempotency-conflict' USING ERRCODE='23514'; END IF;RETURN true;END IF;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=rid AND workspace_id=w AND book_id=b FOR UPDATE;
 IF NOT FOUND OR r.revision<>expected OR r.status<>'needs-review' OR NOT EXISTS(SELECT FROM emdo.finance_report_mapping_versions WHERE id=mid AND workspace_id=w AND book_id=b AND evidence_id=r.evidence_id AND status='candidate') THEN RAISE EXCEPTION 'standardization-reviewed-mapping-conflict' USING ERRCODE='23514'; END IF;
 UPDATE emdo.finance_standardization_runs SET reviewed_mapping_id=mid,revision=revision+1,updated_at=clock_timestamp() WHERE id=rid;
 INSERT INTO emdo.finance_command_receipts(workspace_id,user_id,idempotency_key,operation,payload_hash,result) VALUES(w,emdo.current_user_id(),k,'standardization.link-mapping',h,jsonb_build_object('id',rid));RETURN true;
END $$;
ALTER FUNCTION emdo.link_standardization_mapping(uuid,uuid,uuid,integer,uuid,text) OWNER TO emdo_finance_standardization_executor;
REVOKE ALL ON FUNCTION emdo.link_standardization_mapping(uuid,uuid,uuid,integer,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.link_standardization_mapping(uuid,uuid,uuid,integer,uuid,text) TO emdo_app;
