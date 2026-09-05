CREATE TABLE "emdo"."finance_document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"extraction_revision" integer NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"page_start" integer NOT NULL,
	"page_end" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"search_vector" "tsvector" NOT NULL,
	"embedding" vector(1536),
	"committed_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "finance_document_chunks_document_ordinal_unique" UNIQUE("document_id","extraction_revision","ordinal"),
	CONSTRAINT "finance_document_chunks_revision_check" CHECK ("emdo"."finance_document_chunks"."extraction_revision" > 0),
	CONSTRAINT "finance_document_chunks_ordinal_check" CHECK ("emdo"."finance_document_chunks"."ordinal" >= 0),
	CONSTRAINT "finance_document_chunks_page_check" CHECK ("emdo"."finance_document_chunks"."page_start" between 1 and 250 and "emdo"."finance_document_chunks"."page_end" between "emdo"."finance_document_chunks"."page_start" and 250),
	CONSTRAINT "finance_document_chunks_content_check" CHECK (octet_length("emdo"."finance_document_chunks"."content") between 1 and 16384 and "emdo"."finance_document_chunks"."content_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "finance_document_chunks_deletion_check" CHECK ("emdo"."finance_document_chunks"."deleted_at" is null or "emdo"."finance_document_chunks"."deleted_at" >= "emdo"."finance_document_chunks"."committed_at")
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_document_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"extraction_revision" integer NOT NULL,
	"chunk_id" uuid,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"page" integer NOT NULL,
	"excerpt" text NOT NULL,
	"excerpt_hash" text NOT NULL,
	"locator" jsonb NOT NULL,
	"source_locale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "finance_document_evidence_source_unique" UNIQUE("document_id","extraction_revision","page","excerpt_hash"),
	CONSTRAINT "finance_document_evidence_revision_check" CHECK ("emdo"."finance_document_evidence"."extraction_revision" > 0),
	CONSTRAINT "finance_document_evidence_page_check" CHECK ("emdo"."finance_document_evidence"."page" between 1 and 250),
	CONSTRAINT "finance_document_evidence_excerpt_check" CHECK (octet_length("emdo"."finance_document_evidence"."excerpt") between 1 and 8192 and "emdo"."finance_document_evidence"."excerpt_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "finance_document_evidence_locator_check" CHECK (jsonb_typeof("emdo"."finance_document_evidence"."locator") = 'object' and octet_length("emdo"."finance_document_evidence"."locator"::text) between 2 and 4096),
	CONSTRAINT "finance_document_evidence_locale_check" CHECK ("emdo"."finance_document_evidence"."source_locale" in ('en-CA', 'fr-CA', 'ja-JP', 'ko-KR')),
	CONSTRAINT "finance_document_evidence_deletion_check" CHECK ("emdo"."finance_document_evidence"."deleted_at" is null or "emdo"."finance_document_evidence"."deleted_at" >= "emdo"."finance_document_evidence"."created_at")
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_document_extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"attempt" smallint NOT NULL,
	"state" text NOT NULL,
	"model" text,
	"schema_version" smallint DEFAULT 1 NOT NULL,
	"encrypted_payload" jsonb,
	"redacted_summary" jsonb,
	"response_hash" text,
	"safe_error_code" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "finance_document_extractions_document_revision_unique" UNIQUE("document_id","revision"),
	CONSTRAINT "finance_document_extractions_scope_id_unique" UNIQUE("household_id","space_id","original_owner_user_id","id"),
	CONSTRAINT "finance_document_extractions_revision_check" CHECK ("emdo"."finance_document_extractions"."revision" > 0),
	CONSTRAINT "finance_document_extractions_attempt_check" CHECK ("emdo"."finance_document_extractions"."attempt" between 1 and 2),
	CONSTRAINT "finance_document_extractions_state_check" CHECK ("emdo"."finance_document_extractions"."state" in ('queued', 'extracting', 'awaiting-review', 'committed', 'failed', 'superseded')),
	CONSTRAINT "finance_document_extractions_schema_check" CHECK ("emdo"."finance_document_extractions"."schema_version" = 1),
	CONSTRAINT "finance_document_extractions_model_check" CHECK ("emdo"."finance_document_extractions"."model" is null or "emdo"."finance_document_extractions"."model" = 'gpt-5.6-terra'),
	CONSTRAINT "finance_document_extractions_payload_check" CHECK ("emdo"."finance_document_extractions"."encrypted_payload" is null or (jsonb_typeof("emdo"."finance_document_extractions"."encrypted_payload") = 'object' and octet_length("emdo"."finance_document_extractions"."encrypted_payload"::text) between 2 and 16777216)),
	CONSTRAINT "finance_document_extractions_summary_check" CHECK ("emdo"."finance_document_extractions"."redacted_summary" is null or (jsonb_typeof("emdo"."finance_document_extractions"."redacted_summary") = 'object' and octet_length("emdo"."finance_document_extractions"."redacted_summary"::text) between 2 and 1048576)),
	CONSTRAINT "finance_document_extractions_hash_check" CHECK ("emdo"."finance_document_extractions"."response_hash" is null or "emdo"."finance_document_extractions"."response_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "finance_document_extractions_usage_check" CHECK (("emdo"."finance_document_extractions"."input_tokens" is null or "emdo"."finance_document_extractions"."input_tokens" >= 0) and ("emdo"."finance_document_extractions"."output_tokens" is null or "emdo"."finance_document_extractions"."output_tokens" >= 0)),
	CONSTRAINT "finance_document_extractions_completion_check" CHECK (("emdo"."finance_document_extractions"."state" in ('queued', 'extracting') and "emdo"."finance_document_extractions"."completed_at" is null) or ("emdo"."finance_document_extractions"."state" in ('awaiting-review', 'committed', 'failed', 'superseded') and "emdo"."finance_document_extractions"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_document_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"extraction_revision" integer NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"score_basis_points" integer NOT NULL,
	"reasons" jsonb NOT NULL,
	"state" text DEFAULT 'suggested' NOT NULL,
	"decision_review_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "finance_document_matches_record_unique" UNIQUE("document_id","extraction_revision","record_type","record_id"),
	CONSTRAINT "finance_document_matches_revision_check" CHECK ("emdo"."finance_document_matches"."extraction_revision" > 0),
	CONSTRAINT "finance_document_matches_record_check" CHECK ("emdo"."finance_document_matches"."record_type" in ('account', 'transaction', 'category', 'budget', 'bill', 'subscription', 'goal') and length("emdo"."finance_document_matches"."record_id") between 1 and 512 and "emdo"."finance_document_matches"."record_id" !~ '[[:cntrl:]]'),
	CONSTRAINT "finance_document_matches_score_check" CHECK ("emdo"."finance_document_matches"."score_basis_points" between 0 and 10000),
	CONSTRAINT "finance_document_matches_reasons_check" CHECK (jsonb_typeof("emdo"."finance_document_matches"."reasons") = 'array' and jsonb_array_length("emdo"."finance_document_matches"."reasons") between 1 and 8 and octet_length("emdo"."finance_document_matches"."reasons"::text) <= 4096),
	CONSTRAINT "finance_document_matches_state_check" CHECK ("emdo"."finance_document_matches"."state" in ('suggested', 'accepted', 'rejected') and (("emdo"."finance_document_matches"."state" = 'suggested' and "emdo"."finance_document_matches"."decided_at" is null and "emdo"."finance_document_matches"."decision_review_batch_id" is null) or ("emdo"."finance_document_matches"."state" <> 'suggested' and "emdo"."finance_document_matches"."decided_at" is not null and "emdo"."finance_document_matches"."decision_review_batch_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_document_review_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"extraction_revision" integer NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"authenticated_session_id" uuid NOT NULL,
	"space_access_grant_id" uuid NOT NULL,
	"scope_fingerprint" text NOT NULL,
	"payload_hash" text NOT NULL,
	"review_token_hash" text NOT NULL,
	"selected_facts" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "finance_document_review_batches_token_unique" UNIQUE("review_token_hash"),
	CONSTRAINT "finance_document_review_batches_owner_idempotency_unique" UNIQUE("household_id","original_owner_user_id","idempotency_key"),
	CONSTRAINT "finance_document_review_batches_match_binding_unique" UNIQUE("household_id","space_id","original_owner_user_id","document_id","extraction_revision","id"),
	CONSTRAINT "finance_document_review_batches_revision_check" CHECK ("emdo"."finance_document_review_batches"."extraction_revision" > 0),
	CONSTRAINT "finance_document_review_batches_hash_check" CHECK ("emdo"."finance_document_review_batches"."scope_fingerprint" ~ '^[a-f0-9]{64}$' and "emdo"."finance_document_review_batches"."payload_hash" ~ '^[a-f0-9]{64}$' and "emdo"."finance_document_review_batches"."review_token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "finance_document_review_batches_payload_check" CHECK (jsonb_typeof("emdo"."finance_document_review_batches"."selected_facts") = 'object' and octet_length("emdo"."finance_document_review_batches"."selected_facts"::text) between 2 and 4194304),
	CONSTRAINT "finance_document_review_batches_state_check" CHECK ("emdo"."finance_document_review_batches"."state" in ('pending', 'committed', 'rejected', 'expired', 'invalidated')),
	CONSTRAINT "finance_document_review_batches_key_check" CHECK (length("emdo"."finance_document_review_batches"."idempotency_key") between 16 and 200 and "emdo"."finance_document_review_batches"."idempotency_key" ~ '^[A-Za-z0-9:._-]+$'),
	CONSTRAINT "finance_document_review_batches_lifetime_check" CHECK ("emdo"."finance_document_review_batches"."expires_at" > "emdo"."finance_document_review_batches"."created_at" and "emdo"."finance_document_review_batches"."expires_at" <= "emdo"."finance_document_review_batches"."created_at" + interval '30 minutes' and (("emdo"."finance_document_review_batches"."state" = 'pending' and "emdo"."finance_document_review_batches"."decided_at" is null) or ("emdo"."finance_document_review_batches"."state" <> 'pending' and "emdo"."finance_document_review_batches"."decided_at" is not null)))
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"storage_object_id" text,
	"display_name" text,
	"mime_type" text,
	"byte_size" bigint,
	"page_count" integer,
	"image_width" integer,
	"image_height" integer,
	"plaintext_sha256" text,
	"ciphertext_sha256" text,
	"wrapped_data_key" jsonb,
	"key_version" text,
	"state" text DEFAULT 'uploaded' NOT NULL,
	"document_type" text,
	"source_locale" text,
	"currency" text,
	"extraction_revision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deletion_proposal_id" uuid,
	"deletion_decision_id" uuid,
	"deletion_target_binding_hash" text,
	"deletion_execution_binding_hash" text,
	CONSTRAINT "finance_documents_scope_id_unique" UNIQUE("household_id","space_id","original_owner_user_id","id"),
	CONSTRAINT "finance_documents_storage_object_unique" UNIQUE("storage_object_id"),
	CONSTRAINT "finance_documents_owner_plaintext_hash_unique" UNIQUE("household_id","original_owner_user_id","plaintext_sha256"),
	CONSTRAINT "finance_documents_storage_object_check" CHECK ("emdo"."finance_documents"."storage_object_id" is null or (length("emdo"."finance_documents"."storage_object_id") between 16 and 200 and "emdo"."finance_documents"."storage_object_id" ~ '^[A-Za-z0-9._-]+$')),
	CONSTRAINT "finance_documents_display_name_check" CHECK ("emdo"."finance_documents"."display_name" is null or (length("emdo"."finance_documents"."display_name") between 1 and 255 and "emdo"."finance_documents"."display_name" !~ '[[:cntrl:]]')),
	CONSTRAINT "finance_documents_mime_type_check" CHECK ("emdo"."finance_documents"."mime_type" is null or "emdo"."finance_documents"."mime_type" in ('application/pdf', 'image/jpeg', 'image/png')),
	CONSTRAINT "finance_documents_byte_size_check" CHECK ("emdo"."finance_documents"."byte_size" is null or "emdo"."finance_documents"."byte_size" between 1 and 26214400),
	CONSTRAINT "finance_documents_dimension_check" CHECK ("emdo"."finance_documents"."mime_type" is null or ("emdo"."finance_documents"."mime_type" = 'application/pdf' and "emdo"."finance_documents"."page_count" between 1 and 250 and "emdo"."finance_documents"."image_width" is null and "emdo"."finance_documents"."image_height" is null) or ("emdo"."finance_documents"."mime_type" in ('image/jpeg', 'image/png') and "emdo"."finance_documents"."page_count" is null and "emdo"."finance_documents"."image_width" > 0 and "emdo"."finance_documents"."image_height" > 0 and "emdo"."finance_documents"."image_width"::bigint * "emdo"."finance_documents"."image_height"::bigint <= 40000000)),
	CONSTRAINT "finance_documents_hash_check" CHECK (("emdo"."finance_documents"."plaintext_sha256" is null and "emdo"."finance_documents"."ciphertext_sha256" is null) or ("emdo"."finance_documents"."plaintext_sha256" ~ '^[a-f0-9]{64}$' and "emdo"."finance_documents"."ciphertext_sha256" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "finance_documents_wrapped_key_check" CHECK (("emdo"."finance_documents"."wrapped_data_key" is null and "emdo"."finance_documents"."key_version" is null) or (jsonb_typeof("emdo"."finance_documents"."wrapped_data_key") = 'object' and octet_length("emdo"."finance_documents"."wrapped_data_key"::text) between 2 and 16384 and length("emdo"."finance_documents"."key_version") between 1 and 100)),
	CONSTRAINT "finance_documents_state_check" CHECK ("emdo"."finance_documents"."state" in ('uploaded', 'extracting', 'awaiting-review', 'committed', 'failed', 'deleting', 'deleted')),
	CONSTRAINT "finance_documents_type_check" CHECK ("emdo"."finance_documents"."document_type" is null or "emdo"."finance_documents"."document_type" in ('receipt', 'invoice', 'bank-statement', 'credit-statement', 'pay-stub', 'tax-slip', 'insurance', 'loan', 'investment-statement', 'other')),
	CONSTRAINT "finance_documents_locale_check" CHECK ("emdo"."finance_documents"."source_locale" is null or "emdo"."finance_documents"."source_locale" in ('en-CA', 'fr-CA', 'ja-JP', 'ko-KR')),
	CONSTRAINT "finance_documents_currency_check" CHECK ("emdo"."finance_documents"."currency" is null or "emdo"."finance_documents"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "finance_documents_revision_check" CHECK ("emdo"."finance_documents"."extraction_revision" is null or "emdo"."finance_documents"."extraction_revision" > 0),
	CONSTRAINT "finance_documents_deletion_check" CHECK (("emdo"."finance_documents"."state" = 'deleted' and "emdo"."finance_documents"."deleted_at" is not null and "emdo"."finance_documents"."storage_object_id" is null and "emdo"."finance_documents"."display_name" is null and "emdo"."finance_documents"."mime_type" is null and "emdo"."finance_documents"."byte_size" is null and "emdo"."finance_documents"."page_count" is null and "emdo"."finance_documents"."image_width" is null and "emdo"."finance_documents"."image_height" is null and "emdo"."finance_documents"."plaintext_sha256" is null and "emdo"."finance_documents"."ciphertext_sha256" is null and "emdo"."finance_documents"."wrapped_data_key" is null and "emdo"."finance_documents"."key_version" is null and "emdo"."finance_documents"."document_type" is null and "emdo"."finance_documents"."source_locale" is null and "emdo"."finance_documents"."currency" is null and "emdo"."finance_documents"."extraction_revision" is null) or ("emdo"."finance_documents"."state" <> 'deleted' and "emdo"."finance_documents"."deleted_at" is null and "emdo"."finance_documents"."storage_object_id" is not null and "emdo"."finance_documents"."display_name" is not null and "emdo"."finance_documents"."mime_type" is not null and "emdo"."finance_documents"."byte_size" is not null and "emdo"."finance_documents"."plaintext_sha256" is not null and "emdo"."finance_documents"."ciphertext_sha256" is not null and "emdo"."finance_documents"."wrapped_data_key" is not null and "emdo"."finance_documents"."key_version" is not null)),
	CONSTRAINT "finance_documents_guarded_deletion_receipt_check" CHECK ((("emdo"."finance_documents"."state" in ('deleting', 'deleted')) and "emdo"."finance_documents"."deletion_proposal_id" is not null and "emdo"."finance_documents"."deletion_decision_id" is not null and "emdo"."finance_documents"."deletion_target_binding_hash" ~ '^[a-f0-9]{64}$' and "emdo"."finance_documents"."deletion_execution_binding_hash" ~ '^[a-f0-9]{64}$') or (("emdo"."finance_documents"."state" not in ('deleting', 'deleted')) and "emdo"."finance_documents"."deletion_proposal_id" is null and "emdo"."finance_documents"."deletion_decision_id" is null and "emdo"."finance_documents"."deletion_target_binding_hash" is null and "emdo"."finance_documents"."deletion_execution_binding_hash" is null)),
	CONSTRAINT "finance_documents_timestamps_check" CHECK ("emdo"."finance_documents"."updated_at" >= "emdo"."finance_documents"."created_at" and ("emdo"."finance_documents"."deleted_at" is null or "emdo"."finance_documents"."deleted_at" >= "emdo"."finance_documents"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "emdo"."finance_document_chunks" ADD CONSTRAINT "finance_document_chunks_document_fk" FOREIGN KEY ("household_id","space_id","original_owner_user_id","document_id") REFERENCES "emdo"."finance_documents"("household_id","space_id","original_owner_user_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."finance_document_evidence" ADD CONSTRAINT "finance_document_evidence_document_fk" FOREIGN KEY ("household_id","space_id","original_owner_user_id","document_id") REFERENCES "emdo"."finance_documents"("household_id","space_id","original_owner_user_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."finance_document_evidence" ADD CONSTRAINT "finance_document_evidence_chunk_fk" FOREIGN KEY ("chunk_id") REFERENCES "emdo"."finance_document_chunks"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."finance_document_extractions" ADD CONSTRAINT "finance_document_extractions_document_fk" FOREIGN KEY ("household_id","space_id","original_owner_user_id","document_id") REFERENCES "emdo"."finance_documents"("household_id","space_id","original_owner_user_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."finance_document_matches" ADD CONSTRAINT "finance_document_matches_document_fk" FOREIGN KEY ("household_id","space_id","original_owner_user_id","document_id") REFERENCES "emdo"."finance_documents"("household_id","space_id","original_owner_user_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."finance_document_matches" ADD CONSTRAINT "finance_document_matches_review_batch_fk" FOREIGN KEY ("household_id","space_id","original_owner_user_id","document_id","extraction_revision","decision_review_batch_id") REFERENCES "emdo"."finance_document_review_batches"("household_id","space_id","original_owner_user_id","document_id","extraction_revision","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."finance_document_review_batches" ADD CONSTRAINT "finance_document_review_batches_document_fk" FOREIGN KEY ("household_id","space_id","original_owner_user_id","document_id") REFERENCES "emdo"."finance_documents"("household_id","space_id","original_owner_user_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."finance_documents" ADD CONSTRAINT "finance_documents_household_space_fk" FOREIGN KEY ("household_id","space_id") REFERENCES "emdo"."spaces"("household_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."finance_documents" ADD CONSTRAINT "finance_documents_owner_membership_fk" FOREIGN KEY ("household_id","original_owner_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "finance_document_chunks_scope_document_idx" ON "emdo"."finance_document_chunks" USING btree ("household_id","original_owner_user_id","document_id","extraction_revision");--> statement-breakpoint
CREATE INDEX "finance_document_chunks_search_gin_idx" ON "emdo"."finance_document_chunks" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "finance_document_chunks_embedding_hnsw_idx" ON "emdo"."finance_document_chunks" USING hnsw ("embedding" vector_cosine_ops) WHERE "emdo"."finance_document_chunks"."embedding" is not null and "emdo"."finance_document_chunks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "finance_document_evidence_owner_document_idx" ON "emdo"."finance_document_evidence" USING btree ("household_id","original_owner_user_id","document_id");--> statement-breakpoint
CREATE INDEX "finance_document_extractions_owner_state_idx" ON "emdo"."finance_document_extractions" USING btree ("household_id","original_owner_user_id","state","created_at");--> statement-breakpoint
CREATE INDEX "finance_document_matches_owner_state_idx" ON "emdo"."finance_document_matches" USING btree ("household_id","original_owner_user_id","state","created_at");--> statement-breakpoint
CREATE INDEX "finance_document_review_batches_document_state_idx" ON "emdo"."finance_document_review_batches" USING btree ("document_id","extraction_revision","state");--> statement-breakpoint
CREATE INDEX "finance_documents_owner_state_updated_idx" ON "emdo"."finance_documents" USING btree ("household_id","original_owner_user_id","state","updated_at");
--> statement-breakpoint
DO $roles$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_finance_document_executor'
	) THEN
		CREATE ROLE emdo_finance_document_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$roles$;
ALTER ROLE emdo_finance_document_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
--> statement-breakpoint
DO $membership_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname = 'emdo_finance_document_executor'
			OR child.rolname = 'emdo_finance_document_executor'
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'finance document executor must not have role memberships';
	END IF;
END
$membership_guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.is_active_finance_document_scope(
	p_household_id uuid,
	p_space_id uuid,
	p_owner_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
	SELECT COALESCE(
		p_owner_user_id = emdo.current_user_id()
		AND emdo.is_active_request_scope(
			p_household_id,
			p_space_id,
			NULL
		)
		AND EXISTS (
			SELECT 1
			FROM emdo.spaces AS space
			WHERE space.household_id = p_household_id
				AND space.id = p_space_id
				AND space.visibility = 'private'
				AND space.original_owner_user_id = p_owner_user_id
		),
		false
	);
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.set_finance_document_search_vector()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, emdo
AS $function$
BEGIN
	NEW.search_vector := pg_catalog.to_tsvector('simple', NEW.content);
	RETURN NEW;
END
$function$;
CREATE TRIGGER finance_document_chunks_search_vector
BEFORE INSERT OR UPDATE OF content ON emdo.finance_document_chunks
FOR EACH ROW EXECUTE FUNCTION emdo.set_finance_document_search_vector();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.invalidate_finance_document_reviews_on_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
BEGIN
	IF OLD.extraction_revision IS DISTINCT FROM NEW.extraction_revision THEN
		UPDATE emdo.finance_document_review_batches
		SET state = 'invalidated', decided_at = pg_catalog.clock_timestamp()
		WHERE household_id = NEW.household_id
			AND space_id = NEW.space_id
			AND original_owner_user_id = NEW.original_owner_user_id
			AND document_id = NEW.id
			AND state = 'pending';
	END IF;
	RETURN NEW;
END
$function$;
CREATE TRIGGER finance_documents_review_revision_invalidation
AFTER UPDATE OF extraction_revision ON emdo.finance_documents
FOR EACH ROW EXECUTE FUNCTION emdo.invalidate_finance_document_reviews_on_revision();
--> statement-breakpoint
ALTER TABLE emdo.finance_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_document_extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_document_extractions FORCE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_document_chunks FORCE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_document_review_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_document_review_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_document_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_document_matches FORCE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_document_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_document_evidence FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY finance_documents_uploader_scope
ON emdo.finance_documents
FOR ALL TO emdo_app
USING (
	emdo.is_active_finance_document_scope(
		household_id, space_id, original_owner_user_id
	)
)
WITH CHECK (
	emdo.is_active_finance_document_scope(
		household_id, space_id, original_owner_user_id
	)
);
CREATE POLICY finance_document_extractions_uploader_scope
ON emdo.finance_document_extractions
FOR ALL TO emdo_app
USING (
	emdo.is_active_finance_document_scope(
		household_id, space_id, original_owner_user_id
	)
)
WITH CHECK (
	emdo.is_active_finance_document_scope(
		household_id, space_id, original_owner_user_id
	)
);
CREATE POLICY finance_document_chunks_uploader_scope
ON emdo.finance_document_chunks
FOR ALL TO emdo_app
USING (
	emdo.is_active_finance_document_scope(
		household_id, space_id, original_owner_user_id
	)
)
WITH CHECK (
	emdo.is_active_finance_document_scope(
		household_id, space_id, original_owner_user_id
	)
);
CREATE POLICY finance_document_review_batches_uploader_scope
ON emdo.finance_document_review_batches
FOR ALL TO emdo_app
USING (
	emdo.is_active_finance_document_scope(
		household_id, space_id, original_owner_user_id
	)
)
WITH CHECK (
	emdo.is_active_finance_document_scope(
		household_id, space_id, original_owner_user_id
	)
);
CREATE POLICY finance_document_matches_uploader_scope
ON emdo.finance_document_matches
FOR ALL TO emdo_app
USING (
	emdo.is_active_finance_document_scope(
		household_id, space_id, original_owner_user_id
	)
)
WITH CHECK (
	emdo.is_active_finance_document_scope(
		household_id, space_id, original_owner_user_id
	)
);
CREATE POLICY finance_document_evidence_uploader_scope
ON emdo.finance_document_evidence
FOR ALL TO emdo_app
USING (
	emdo.is_active_finance_document_scope(
		household_id, space_id, original_owner_user_id
	)
)
WITH CHECK (
	emdo.is_active_finance_document_scope(
		household_id, space_id, original_owner_user_id
	)
);
CREATE POLICY finance_documents_executor_scope
ON emdo.finance_documents FOR ALL TO emdo_finance_document_executor
USING (true) WITH CHECK (true);
CREATE POLICY finance_document_extractions_executor_scope
ON emdo.finance_document_extractions FOR ALL TO emdo_finance_document_executor
USING (true) WITH CHECK (true);
CREATE POLICY finance_document_chunks_executor_scope
ON emdo.finance_document_chunks FOR ALL TO emdo_finance_document_executor
USING (true) WITH CHECK (true);
CREATE POLICY finance_document_review_batches_executor_scope
ON emdo.finance_document_review_batches FOR ALL TO emdo_finance_document_executor
USING (true) WITH CHECK (true);
CREATE POLICY finance_document_matches_executor_scope
ON emdo.finance_document_matches FOR ALL TO emdo_finance_document_executor
USING (true) WITH CHECK (true);
CREATE POLICY finance_document_evidence_executor_scope
ON emdo.finance_document_evidence FOR ALL TO emdo_finance_document_executor
USING (true) WITH CHECK (true);
--> statement-breakpoint
REVOKE ALL ON TABLE
	emdo.finance_documents,
	emdo.finance_document_extractions,
	emdo.finance_document_chunks,
	emdo.finance_document_review_batches,
	emdo.finance_document_matches,
	emdo.finance_document_evidence
FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
	emdo.finance_documents,
	emdo.finance_document_extractions,
	emdo.finance_document_chunks,
	emdo.finance_document_review_batches,
	emdo.finance_document_matches,
	emdo.finance_document_evidence
TO emdo_app, emdo_finance_document_executor;
REVOKE ALL ON FUNCTION
	emdo.is_active_finance_document_scope(uuid, uuid, uuid),
	emdo.set_finance_document_search_vector()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
	emdo.is_active_finance_document_scope(uuid, uuid, uuid)
TO emdo_app, emdo_finance_document_executor;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.claim_next_finance_document_extraction()
RETURNS TABLE (
	household_id uuid,
	space_id uuid,
	original_owner_user_id uuid,
	document_id uuid,
	extraction_revision integer,
	extraction_attempt smallint,
	storage_object_id text,
	mime_type text,
	byte_size bigint,
	page_count integer,
	image_width integer,
	image_height integer,
	plaintext_sha256 text,
	ciphertext_sha256 text,
	wrapped_data_key jsonb,
	key_version text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_document emdo.finance_documents%ROWTYPE;
	v_revision integer;
	v_attempt smallint;
BEGIN
	IF NOT pg_catalog.pg_try_advisory_xact_lock(
		pg_catalog.hashtext('emdo.finance.document.extraction.v1')
	) THEN
		RETURN;
	END IF;

	UPDATE emdo.finance_document_extractions AS extraction
	SET state = 'failed',
		safe_error_code = 'worker-lease-expired',
		completed_at = pg_catalog.clock_timestamp()
	FROM emdo.finance_documents AS document
	WHERE document.id = extraction.document_id
		AND document.household_id = extraction.household_id
		AND document.space_id = extraction.space_id
		AND document.original_owner_user_id = extraction.original_owner_user_id
		AND document.state = 'extracting'
		AND extraction.state = 'extracting'
		AND document.updated_at < pg_catalog.clock_timestamp() - interval '10 minutes';
	UPDATE emdo.finance_documents AS document
	SET state = 'failed', updated_at = pg_catalog.clock_timestamp()
	WHERE document.state = 'extracting'
		AND document.updated_at < pg_catalog.clock_timestamp() - interval '10 minutes'
		AND EXISTS (
			SELECT 1 FROM emdo.finance_document_extractions AS extraction
			WHERE extraction.document_id = document.id
				AND extraction.revision = document.extraction_revision
				AND extraction.state = 'failed'
		);

	IF EXISTS (
		SELECT 1 FROM emdo.finance_document_extractions
		WHERE state = 'extracting'
	) THEN
		RETURN;
	END IF;

	SELECT document.* INTO v_document
	FROM emdo.finance_documents AS document
	WHERE document.state = 'uploaded'
		OR (
			document.state = 'extracting'
			AND EXISTS (
				SELECT 1
				FROM emdo.finance_document_extractions AS queued
				WHERE queued.document_id = document.id
					AND queued.household_id = document.household_id
					AND queued.space_id = document.space_id
					AND queued.original_owner_user_id = document.original_owner_user_id
					AND queued.revision = document.extraction_revision
					AND queued.state = 'queued'
			)
		)
	ORDER BY CASE WHEN document.state = 'extracting' THEN 0 ELSE 1 END,
		document.created_at, document.id
	LIMIT 1
	FOR UPDATE SKIP LOCKED;
	IF NOT FOUND THEN RETURN; END IF;

	IF v_document.state = 'uploaded' THEN
		v_revision := COALESCE(v_document.extraction_revision, 1);
		v_attempt := 1;
		INSERT INTO emdo.finance_document_extractions (
			document_id, household_id, space_id, original_owner_user_id,
			revision, attempt, state, model
		) VALUES (
			v_document.id, v_document.household_id, v_document.space_id,
			v_document.original_owner_user_id, v_revision, v_attempt,
			'extracting', 'gpt-5.6-terra'
		)
		ON CONFLICT (document_id, revision) DO UPDATE
		SET state = 'extracting', model = 'gpt-5.6-terra',
			safe_error_code = NULL, completed_at = NULL
		WHERE emdo.finance_document_extractions.state = 'queued';
		IF NOT FOUND THEN RETURN; END IF;
	ELSE
		UPDATE emdo.finance_document_extractions AS extraction
		SET state = 'extracting', model = 'gpt-5.6-terra',
			safe_error_code = NULL, completed_at = NULL
		WHERE extraction.document_id = v_document.id
			AND extraction.revision = v_document.extraction_revision
			AND extraction.state = 'queued'
		RETURNING extraction.revision, extraction.attempt
		INTO v_revision, v_attempt;
		IF NOT FOUND THEN RETURN; END IF;
	END IF;

	UPDATE emdo.finance_documents
	SET state = 'extracting', extraction_revision = v_revision,
		updated_at = pg_catalog.clock_timestamp()
	WHERE id = v_document.id;

	RETURN QUERY SELECT v_document.household_id, v_document.space_id,
		v_document.original_owner_user_id, v_document.id, v_revision, v_attempt,
		v_document.storage_object_id, v_document.mime_type, v_document.byte_size,
		v_document.page_count, v_document.image_width, v_document.image_height,
		v_document.plaintext_sha256, v_document.ciphertext_sha256,
		v_document.wrapped_data_key, v_document.key_version;
END
$function$;

CREATE OR REPLACE FUNCTION emdo.complete_finance_document_extraction(
	p_document_id uuid,
	p_extraction_revision integer,
	p_attempt smallint,
	p_encrypted_payload jsonb,
	p_redacted_summary jsonb,
	p_response_hash text,
	p_input_tokens integer,
	p_output_tokens integer,
	p_document_type text,
	p_source_locale text,
	p_currency text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
BEGIN
	IF p_extraction_revision < 1 OR p_attempt NOT BETWEEN 1 AND 2
		OR p_encrypted_payload IS NULL OR p_redacted_summary IS NULL
		OR p_response_hash !~ '^[a-f0-9]{64}$'
		OR p_input_tokens < 0 OR p_output_tokens < 0 THEN
		RETURN false;
	END IF;
	PERFORM 1
	FROM emdo.finance_documents AS document
	WHERE document.id = p_document_id
		AND document.extraction_revision = p_extraction_revision
		AND document.state = 'extracting'
	FOR UPDATE;
	IF NOT FOUND THEN RETURN false; END IF;
	UPDATE emdo.finance_document_extractions AS extraction
	SET attempt = p_attempt, state = 'awaiting-review',
		encrypted_payload = p_encrypted_payload,
		redacted_summary = p_redacted_summary,
		response_hash = p_response_hash,
		input_tokens = p_input_tokens,
		output_tokens = p_output_tokens,
		completed_at = pg_catalog.clock_timestamp()
	WHERE extraction.document_id = p_document_id
		AND extraction.revision = p_extraction_revision
		AND extraction.state = 'extracting';
	IF NOT FOUND THEN RETURN false; END IF;
	UPDATE emdo.finance_documents AS document
	SET state = 'awaiting-review', document_type = p_document_type,
		source_locale = p_source_locale, currency = p_currency,
		updated_at = pg_catalog.clock_timestamp()
	WHERE document.id = p_document_id
		AND document.extraction_revision = p_extraction_revision
		AND document.state = 'extracting';
	IF NOT FOUND THEN
		RAISE EXCEPTION 'finance document extraction settlement lost its locked document'
			USING ERRCODE = '40001';
	END IF;
	RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION emdo.fail_finance_document_extraction(
	p_document_id uuid,
	p_extraction_revision integer,
	p_attempt smallint,
	p_safe_error_code text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
BEGIN
	IF p_extraction_revision < 1 OR p_attempt NOT BETWEEN 1 AND 2
		OR p_safe_error_code IS NULL
		OR pg_catalog.length(p_safe_error_code) NOT BETWEEN 1 AND 120
		OR p_safe_error_code !~ '^[a-z0-9.-]+$' THEN
		RETURN false;
	END IF;
	PERFORM 1
	FROM emdo.finance_documents AS document
	WHERE document.id = p_document_id
		AND document.extraction_revision = p_extraction_revision
		AND document.state = 'extracting'
	FOR UPDATE;
	IF NOT FOUND THEN RETURN false; END IF;
	UPDATE emdo.finance_document_extractions AS extraction
	SET attempt = p_attempt, state = 'failed',
		safe_error_code = p_safe_error_code,
		completed_at = pg_catalog.clock_timestamp()
	WHERE extraction.document_id = p_document_id
		AND extraction.revision = p_extraction_revision
		AND extraction.state = 'extracting';
	IF NOT FOUND THEN RETURN false; END IF;
	UPDATE emdo.finance_documents AS document
	SET state = 'failed', updated_at = pg_catalog.clock_timestamp()
	WHERE document.id = p_document_id
		AND document.extraction_revision = p_extraction_revision
		AND document.state = 'extracting';
	IF NOT FOUND THEN
		RAISE EXCEPTION 'finance document extraction failure settlement lost its locked document'
			USING ERRCODE = '40001';
	END IF;
	RETURN true;
END
$function$;
ALTER FUNCTION emdo.invalidate_finance_document_reviews_on_revision()
	OWNER TO emdo_finance_document_executor;
ALTER FUNCTION emdo.claim_next_finance_document_extraction()
	OWNER TO emdo_finance_document_executor;
ALTER FUNCTION emdo.complete_finance_document_extraction(
	uuid, integer, smallint, jsonb, jsonb, text, integer, integer, text, text, text
)
	OWNER TO emdo_finance_document_executor;
ALTER FUNCTION emdo.fail_finance_document_extraction(uuid, integer, smallint, text)
	OWNER TO emdo_finance_document_executor;
GRANT USAGE ON SCHEMA emdo TO emdo_finance_document_executor;
REVOKE ALL ON FUNCTION
	emdo.invalidate_finance_document_reviews_on_revision(),
	emdo.claim_next_finance_document_extraction(),
	emdo.complete_finance_document_extraction(
		uuid, integer, smallint, jsonb, jsonb, text, integer, integer,
		text, text, text
	),
	emdo.fail_finance_document_extraction(uuid, integer, smallint, text)
FROM PUBLIC, emdo_app;
GRANT EXECUTE ON FUNCTION
	emdo.claim_next_finance_document_extraction(),
	emdo.complete_finance_document_extraction(
		uuid, integer, smallint, jsonb, jsonb, text, integer, integer,
		text, text, text
	),
	emdo.fail_finance_document_extraction(uuid, integer, smallint, text)
	TO emdo_worker_executor;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.finance_documents_ready()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
	SELECT
		(SELECT relrowsecurity AND relforcerowsecurity
		 FROM pg_catalog.pg_class
		 WHERE oid = 'emdo.finance_documents'::regclass)
		AND (SELECT relrowsecurity AND relforcerowsecurity
		 FROM pg_catalog.pg_class
		 WHERE oid = 'emdo.finance_document_extractions'::regclass)
		AND (SELECT relrowsecurity AND relforcerowsecurity
		 FROM pg_catalog.pg_class
		 WHERE oid = 'emdo.finance_document_chunks'::regclass)
		AND (SELECT relrowsecurity AND relforcerowsecurity
		 FROM pg_catalog.pg_class
		 WHERE oid = 'emdo.finance_document_review_batches'::regclass)
		AND (SELECT relrowsecurity AND relforcerowsecurity
		 FROM pg_catalog.pg_class
		 WHERE oid = 'emdo.finance_document_matches'::regclass)
		AND (SELECT relrowsecurity AND relforcerowsecurity
		 FROM pg_catalog.pg_class
		 WHERE oid = 'emdo.finance_document_evidence'::regclass)
		AND pg_catalog.has_function_privilege(
			'emdo_app',
			'emdo.is_active_finance_document_scope(uuid,uuid,uuid)',
			'EXECUTE'
		)
		AND NOT pg_catalog.has_function_privilege(
			'public',
			'emdo.is_active_finance_document_scope(uuid,uuid,uuid)',
			'EXECUTE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'public', 'emdo.finance_documents', 'SELECT,INSERT,UPDATE,DELETE'
		)
		AND pg_catalog.has_function_privilege(
			'emdo_worker_executor', 'emdo.claim_next_finance_document_extraction()', 'EXECUTE'
		)
		AND pg_catalog.has_function_privilege(
			'emdo_worker_executor',
			'emdo.complete_finance_document_extraction(uuid,integer,smallint,jsonb,jsonb,text,integer,integer,text,text,text)',
			'EXECUTE'
		)
		AND pg_catalog.has_function_privilege(
			'emdo_worker_executor',
			'emdo.fail_finance_document_extraction(uuid,integer,smallint,text)',
			'EXECUTE'
		)
		AND NOT pg_catalog.has_function_privilege(
			'emdo_app', 'emdo.claim_next_finance_document_extraction()', 'EXECUTE'
		)
		AND NOT pg_catalog.has_function_privilege(
			'public', 'emdo.claim_next_finance_document_extraction()', 'EXECUTE'
		)
		AND NOT pg_catalog.has_function_privilege(
			'emdo_app',
			'emdo.invalidate_finance_document_reviews_on_revision()',
			'EXECUTE'
		)
		AND (
			SELECT pg_catalog.count(*)
			FROM pg_catalog.pg_proc AS procedure
			WHERE procedure.oid IN (
				'emdo.invalidate_finance_document_reviews_on_revision()'::regprocedure,
				'emdo.claim_next_finance_document_extraction()'::regprocedure,
				'emdo.complete_finance_document_extraction(uuid,integer,smallint,jsonb,jsonb,text,integer,integer,text,text,text)'::regprocedure,
				'emdo.fail_finance_document_extraction(uuid,integer,smallint,text)'::regprocedure
			)
				AND procedure.prosecdef
				AND procedure.proowner = 'emdo_finance_document_executor'::regrole
				AND procedure.proconfig @> ARRAY[
					'row_security=on', 'search_path=pg_catalog, emdo'
				]
		) = 4
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_trigger AS trigger
			WHERE trigger.tgname = 'finance_documents_review_revision_invalidation'
				AND trigger.tgrelid = 'emdo.finance_documents'::regclass
				AND NOT trigger.tgisinternal
		)
		AND (
			SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy AS policy
			WHERE policy.polname LIKE 'finance%_executor_scope'
				AND 'emdo_finance_document_executor'::regrole = ANY(policy.polroles)
				AND policy.polrelid IN (
					'emdo.finance_documents'::regclass,
					'emdo.finance_document_extractions'::regclass,
					'emdo.finance_document_chunks'::regclass,
					'emdo.finance_document_review_batches'::regclass,
					'emdo.finance_document_matches'::regclass,
					'emdo.finance_document_evidence'::regclass
				)
		) = 6
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_constraint AS constraint_item
			WHERE constraint_item.conname = 'finance_document_matches_review_batch_fk'
				AND constraint_item.conrelid = 'emdo.finance_document_matches'::regclass
		)
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_roles AS role
			WHERE role.rolname = 'emdo_finance_document_executor'
				AND NOT role.rolcanlogin AND NOT role.rolinherit
				AND NOT role.rolbypassrls AND NOT role.rolsuper
		)
		AND NOT EXISTS (
			SELECT 1 FROM pg_catalog.pg_auth_members AS membership
			JOIN pg_catalog.pg_roles AS role
				ON role.oid IN (membership.roleid, membership.member)
			WHERE role.rolname = 'emdo_finance_document_executor'
		);
$function$;
ALTER FUNCTION emdo.finance_documents_ready() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.finance_documents_ready() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.finance_documents_ready() TO emdo_app;
--> statement-breakpoint

-- A narrow, append-only receipt ties one safe Finance specialist mutation to
-- its canonical entity revision and one content-minimized audit event. It is
-- intentionally separate from sync-client receipts: an agent command is not
-- a client upload and cannot mint or select a sync client.
CREATE TABLE emdo.finance_specialist_record_receipts (
	receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	schema_version smallint DEFAULT 1 NOT NULL,
	household_id uuid NOT NULL,
	space_id uuid NOT NULL,
	original_owner_user_id uuid NOT NULL,
	operation text NOT NULL,
	idempotency_key text NOT NULL,
	canonical_hash text NOT NULL,
	scope_fingerprint text NOT NULL,
	origin_session_id uuid NOT NULL,
	origin_request_id uuid NOT NULL,
	origin_run_id uuid NOT NULL,
	origin_space_access_grant_id uuid NOT NULL,
	entity_type text NOT NULL,
	entity_id text NOT NULL,
	resulting_revision integer NOT NULL,
	audit_event_id uuid NOT NULL,
	recorded_at timestamptz DEFAULT now() NOT NULL,
	retain_until timestamptz DEFAULT (now() + interval '90 days') NOT NULL,
	CONSTRAINT finance_specialist_record_receipts_scope_idempotency_unique
		UNIQUE (household_id, space_id, original_owner_user_id, idempotency_key),
	CONSTRAINT finance_specialist_record_receipts_audit_event_unique
		UNIQUE (audit_event_id),
	CONSTRAINT finance_specialist_record_receipts_schema_check
		CHECK (schema_version = 1),
	CONSTRAINT finance_specialist_record_receipts_operation_check
		CHECK (operation IN (
			'manual-transaction-create', 'transaction-nondestructive-patch',
			'monthly-category-budget-create', 'monthly-category-budget-update',
			'finance-transaction-adjustment', 'finance-transaction-reversal'
		)),
	CONSTRAINT finance_specialist_record_receipts_hash_check
		CHECK (canonical_hash ~ '^[a-f0-9]{64}$'
			AND scope_fingerprint ~ '^[a-f0-9]{64}$'),
	CONSTRAINT finance_specialist_record_receipts_key_check
		CHECK (pg_catalog.length(idempotency_key) BETWEEN 16 AND 200
			AND idempotency_key ~ '^[A-Za-z0-9:._-]+$'),
	CONSTRAINT finance_specialist_record_receipts_entity_check
		CHECK (entity_type IN ('finance.transaction', 'finance.budget')
			AND pg_catalog.length(entity_id) BETWEEN 1 AND 512
			AND entity_id !~ '[[:cntrl:]]'
			AND resulting_revision > 0),
	CONSTRAINT finance_specialist_record_receipts_retention_check
		CHECK (retain_until > recorded_at
			AND retain_until <= recorded_at + interval '90 days')
);
ALTER TABLE emdo.finance_specialist_record_receipts
	ADD CONSTRAINT finance_specialist_record_receipts_household_space_fk
	FOREIGN KEY (household_id, space_id)
	REFERENCES emdo.spaces(household_id, id)
	ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE emdo.finance_specialist_record_receipts
	ADD CONSTRAINT finance_specialist_record_receipts_owner_membership_fk
	FOREIGN KEY (household_id, original_owner_user_id)
	REFERENCES emdo.household_memberships(household_id, user_id)
	ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE emdo.finance_specialist_record_receipts
	ADD CONSTRAINT finance_specialist_record_receipts_audit_event_fk
	FOREIGN KEY (audit_event_id)
	REFERENCES emdo.audit_events(id)
	ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX finance_specialist_record_receipts_scope_recorded_idx
	ON emdo.finance_specialist_record_receipts
	USING btree (household_id, space_id, original_owner_user_id, recorded_at);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION emdo.is_active_finance_specialist_record_scope(
	p_household_id uuid,
	p_space_id uuid,
	p_owner_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
	SELECT COALESCE(
		p_owner_user_id = emdo.current_user_id()
		AND emdo.is_active_request_scope(
			p_household_id,
			p_space_id,
			NULL
		)
		AND EXISTS (
			SELECT 1
			FROM emdo.spaces AS space
			WHERE space.household_id = p_household_id
				AND space.id = p_space_id
				AND space.visibility = 'private'
				AND space.original_owner_user_id = p_owner_user_id
		),
		false
	);
$function$;
CREATE TRIGGER finance_specialist_record_receipts_append_only
BEFORE UPDATE OR DELETE ON emdo.finance_specialist_record_receipts
FOR EACH ROW EXECUTE FUNCTION emdo.reject_append_only_mutation();
ALTER TABLE emdo.finance_specialist_record_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_specialist_record_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY finance_specialist_record_receipts_owner_read
ON emdo.finance_specialist_record_receipts
FOR SELECT TO emdo_app
USING (
	emdo.is_active_finance_specialist_record_scope(
		household_id, space_id, original_owner_user_id
	)
);
CREATE POLICY finance_specialist_record_receipts_owner_insert
ON emdo.finance_specialist_record_receipts
FOR INSERT TO emdo_app
WITH CHECK (
	emdo.is_active_finance_specialist_record_scope(
		household_id, space_id, original_owner_user_id
	)
);
REVOKE ALL ON TABLE emdo.finance_specialist_record_receipts FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE emdo.finance_specialist_record_receipts TO emdo_app;
REVOKE ALL ON FUNCTION
	emdo.is_active_finance_specialist_record_scope(uuid, uuid, uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
	emdo.is_active_finance_specialist_record_scope(uuid, uuid, uuid)
TO emdo_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION emdo.finance_specialist_records_ready()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
	SELECT
		pg_catalog.to_regclass('emdo.finance_specialist_record_receipts')
			IS NOT NULL
		AND (
			SELECT relation.relrowsecurity AND relation.relforcerowsecurity
			FROM pg_catalog.pg_class AS relation
			WHERE relation.oid =
				'emdo.finance_specialist_record_receipts'::regclass
		)
		AND pg_catalog.has_table_privilege(
			'emdo_app', 'emdo.finance_specialist_record_receipts',
			'SELECT,INSERT'
		)
		AND pg_catalog.has_table_privilege(
			'emdo_app', 'emdo.sync_entities', 'SELECT,INSERT,UPDATE'
		)
		AND pg_catalog.has_table_privilege(
			'emdo_app', 'emdo.sync_entity_revisions', 'SELECT'
		)
		AND pg_catalog.has_table_privilege(
			'emdo_app', 'emdo.audit_events', 'SELECT,INSERT'
		)
		AND NOT pg_catalog.has_table_privilege(
			'public', 'emdo.finance_specialist_record_receipts',
			'SELECT,INSERT,UPDATE,DELETE'
		)
		AND pg_catalog.has_function_privilege(
			'emdo_app',
			'emdo.is_active_finance_specialist_record_scope(uuid,uuid,uuid)',
			'EXECUTE'
		)
		AND pg_catalog.has_function_privilege(
			'emdo_app',
			'emdo.resolve_space_access_grant(uuid,uuid,uuid,uuid,uuid,uuid)',
			'EXECUTE'
		)
		AND pg_catalog.has_function_privilege(
			'emdo_app',
			'emdo.lock_active_request_scope(uuid,uuid,uuid)',
			'EXECUTE'
		)
		AND NOT pg_catalog.has_function_privilege(
			'public',
			'emdo.is_active_finance_specialist_record_scope(uuid,uuid,uuid)',
			'EXECUTE'
		)
		AND (
			SELECT pg_catalog.count(*)
			FROM pg_catalog.pg_policy AS policy
			WHERE policy.polrelid =
				'emdo.finance_specialist_record_receipts'::regclass
				AND policy.polname IN (
					'finance_specialist_record_receipts_owner_read',
					'finance_specialist_record_receipts_owner_insert'
				)
				AND 'emdo_app'::regrole = ANY(policy.polroles)
		) = 2
		AND (
			SELECT pg_catalog.count(*)
			FROM pg_catalog.pg_constraint AS constraint_item
			WHERE constraint_item.conrelid =
				'emdo.finance_specialist_record_receipts'::regclass
				AND constraint_item.conname IN (
					'finance_specialist_record_receipts_household_space_fk',
					'finance_specialist_record_receipts_owner_membership_fk',
					'finance_specialist_record_receipts_audit_event_fk',
					'finance_specialist_record_receipts_scope_idempotency_unique',
					'finance_specialist_record_receipts_audit_event_unique',
					'finance_specialist_record_receipts_schema_check',
					'finance_specialist_record_receipts_operation_check',
					'finance_specialist_record_receipts_hash_check',
					'finance_specialist_record_receipts_key_check',
					'finance_specialist_record_receipts_entity_check',
					'finance_specialist_record_receipts_retention_check'
				)
		) = 11
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_trigger AS trigger
			WHERE trigger.tgname =
				'finance_specialist_record_receipts_append_only'
				AND trigger.tgrelid =
					'emdo.finance_specialist_record_receipts'::regclass
				AND NOT trigger.tgisinternal
		);
$function$;
ALTER FUNCTION emdo.finance_specialist_records_ready()
	OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.finance_specialist_records_ready() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.finance_specialist_records_ready() TO emdo_app;
