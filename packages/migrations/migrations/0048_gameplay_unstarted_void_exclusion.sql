-- DC04/DC05: an offered match voided before both players accept is NOT a played
-- game. Keep its durable capture intent and source fingerprint, but close it as an
-- explicit exclusion rather than calling the canonical serializer with absent
-- symbols. This is deliberately narrow: only a zero-revision, zero-move void
-- with no match start time qualifies. Started/resigned/timed-out games still
-- require complete replay and symbol provenance; corrupt played games quarantine.
CREATE OR REPLACE FUNCTION learning.project(cid text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$
DECLARE p jsonb; c learning.captures%ROWTYPE;
BEGIN
 p:=learning.project_unfenced(cid);
 IF COALESCE((p->>'suppressed')::boolean,false) THEN RETURN p; END IF;
 SELECT * INTO c FROM learning.captures WHERE capture_id=cid;
 IF c.intent_error IS NOT NULL OR c.intent_source_token IS NULL THEN RAISE EXCEPTION 'CAPTURE_INTENT_SOURCE_INVALID'; END IF;
 IF p->>'sourceToken' IS DISTINCT FROM c.intent_source_token THEN RAISE EXCEPTION 'CAPTURE_INTENT_SOURCE_CHANGED'; END IF;
 IF p->'source'->>'kind'='match'
  AND p->'source'->>'status'='VOID'
  AND p->'source'->>'startedAt' IS NULL
  AND p->'source'->'revision'='0'::jsonb
  AND p->'source'->'moves'='[]'::jsonb THEN
   p:=p||jsonb_build_object('excluded',true,'exclusionReason','CAPTURE_NOT_STARTED');
 END IF;
 RETURN p;
END $$;
REVOKE ALL ON FUNCTION learning.project(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION learning.project(text) TO capture_runtime;
