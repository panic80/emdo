-- Structured XML originals stay encrypted; parsing and posting require separate review.
CREATE OR REPLACE FUNCTION emdo.check_book_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.uploaded_by IS DISTINCT FROM emdo.current_user_id() OR NEW.format NOT IN ('csv','ofx','qfx','xlsx','pdf','ubl','cii') OR
    NEW.encrypted_original->>'algorithm' IS DISTINCT FROM 'aes-256-gcm' OR NEW.encrypted_original->>'schemaVersion' IS DISTINCT FROM '1'
    OR NEW.encrypted_original->>'aadVersion' IS DISTINCT FROM '1'
    OR coalesce(NEW.encrypted_original->>'ciphertext','') !~ '^[A-Za-z0-9_-]+$'
    OR coalesce(NEW.encrypted_original->>'nonce','') !~ '^[A-Za-z0-9_-]{16}$'
    OR coalesce(NEW.encrypted_original->>'authenticationTag','') !~ '^[A-Za-z0-9_-]{22}$'
    OR coalesce(NEW.encrypted_original->>'wrappedKey','') !~ '^[A-Za-z0-9_-]+$'
    OR coalesce(NEW.encrypted_original->>'keyVersion','') !~ '^finance-documents\.v[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'book evidence requires an authenticated encrypted original' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
