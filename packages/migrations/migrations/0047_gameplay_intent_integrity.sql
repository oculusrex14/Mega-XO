-- Immutable terminal fingerprint and retention fencing. No game rule or economic change.
ALTER TABLE learning.captures ALTER COLUMN source_id DROP NOT NULL;
ALTER TABLE learning.captures DROP CONSTRAINT captures_state_check;
ALTER TABLE learning.captures ADD CONSTRAINT captures_state_check CHECK(state IN ('pending','sealed','quarantined','suppressed','purged','excluded'));
ALTER TABLE learning.captures ADD CONSTRAINT capture_exclusion_empty CHECK(state<>'excluded' OR payload IS NULL);
CREATE OR REPLACE FUNCTION learning.immutable_capture() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,learning,pg_temp AS $$ BEGIN
 IF (NEW.capture_id,NEW.source_kind,CASE WHEN NEW.state IN ('suppressed','purged') AND (NEW.source_id=OLD.capture_id OR NEW.source_id IS NULL) THEN OLD.source_id ELSE NEW.source_id END,NEW.source_attempt,NEW.policy_version,NEW.source_commit,NEW.rules_hash,NEW.environment,NEW.intent_at,NEW.expires_at)
 IS DISTINCT FROM (OLD.capture_id,OLD.source_kind,OLD.source_id,OLD.source_attempt,OLD.policy_version,OLD.source_commit,OLD.rules_hash,OLD.environment,OLD.intent_at,OLD.expires_at) THEN
  RAISE EXCEPTION 'CAPTURE_IDENTITY_IMMUTABLE';
 END IF;
 IF OLD.payload IS NOT NULL AND (NEW.payload,NEW.payload_sha256,NEW.source_token) IS DISTINCT FROM (OLD.payload,OLD.payload_sha256,OLD.source_token)
 AND NOT (NEW.state IN ('suppressed','purged') AND NEW.payload IS NULL AND NEW.payload_sha256 IS NULL AND NEW.source_token IS NULL) THEN
  RAISE EXCEPTION 'CAPTURE_PAYLOAD_IMMUTABLE';
 END IF;
 IF OLD.state IN ('suppressed','purged') AND NEW.state<>OLD.state THEN RAISE EXCEPTION 'CAPTURE_ERASURE_PERMANENT'; END IF;
 RETURN NEW;
END $$;

ALTER TABLE learning.captures ADD COLUMN intent_source_token text CHECK(intent_source_token IS NULL OR intent_source_token ~ '^[a-f0-9]{64}$');
ALTER TABLE learning.captures ADD COLUMN intent_error text CHECK(intent_error IS NULL OR intent_error ~ '^CAPTURE_[A-Z_]+$');

CREATE FUNCTION learning.limit_retention() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE event_at timestamptz; days integer; BEGIN
 SELECT retention_days INTO days FROM learning.policy WHERE id;
 IF NEW.source_kind='match' THEN
  SELECT COALESCE(receipt_at,last_move_at,started_at,created_at) INTO event_at FROM match.matches WHERE match_id=NEW.source_id;
 ELSE
  -- Old fixture attempts have no trustworthy completion time. Room creation is a conservative
  -- bound: never silently extend their retention by assigning the later reconciliation time.
  SELECT created_at INTO event_at FROM tournament.rooms WHERE room_id=NEW.source_id::jsonb->>0;
 END IF;
 IF event_at IS NOT NULL AND days IS NOT NULL THEN NEW.expires_at:=LEAST(NEW.expires_at,event_at+make_interval(days=>days)); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER capture_retention_bound BEFORE INSERT ON learning.captures FOR EACH ROW EXECUTE FUNCTION learning.limit_retention();

CREATE FUNCTION learning.bind_terminal_source() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE source_doc jsonb; BEGIN
 BEGIN
  source_doc:=learning.source(NEW.capture_id);
  IF source_doc IS NULL THEN RAISE EXCEPTION 'CAPTURE_SOURCE_MISSING'; END IF;
  UPDATE learning.captures SET intent_source_token=encode(sha256(convert_to(source_doc::text,'UTF8')),'hex') WHERE capture_id=NEW.capture_id;
 EXCEPTION WHEN data_exception OR raise_exception THEN
  -- Keep the durable obligation without logging raw corrupt source or blocking a valid unrelated
  -- game transaction. The worker quarantines this explicit error; it cannot invent a fingerprint.
  UPDATE learning.captures SET intent_error='CAPTURE_INTENT_SOURCE_INVALID' WHERE capture_id=NEW.capture_id;
 END;
 RETURN NULL;
END $$;
CREATE TRIGGER capture_terminal_fingerprint AFTER INSERT ON learning.captures FOR EACH ROW EXECUTE FUNCTION learning.bind_terminal_source();
CREATE FUNCTION learning.freeze_intent() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,learning,pg_temp AS $$ BEGIN
 IF OLD.intent_source_token IS NOT NULL AND NEW.intent_source_token IS DISTINCT FROM OLD.intent_source_token
 AND NOT (NEW.state IN ('purged','suppressed') AND NEW.intent_source_token IS NULL) THEN RAISE EXCEPTION 'CAPTURE_INTENT_IMMUTABLE'; END IF;
 IF NEW.state IN ('purged','suppressed') THEN NEW.intent_source_token:=NULL;NEW.intent_error:=NULL;NEW.source_id:=NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER capture_intent_immutable BEFORE UPDATE ON learning.captures FOR EACH ROW EXECUTE FUNCTION learning.freeze_intent();

ALTER FUNCTION learning.project(text) RENAME TO project_unfenced;
REVOKE ALL ON FUNCTION learning.project_unfenced(text) FROM capture_runtime,PUBLIC;
CREATE FUNCTION learning.project(cid text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE p jsonb; c learning.captures%ROWTYPE; BEGIN
 p:=learning.project_unfenced(cid);
 IF COALESCE((p->>'suppressed')::boolean,false) THEN RETURN p; END IF;
 SELECT * INTO c FROM learning.captures WHERE capture_id=cid;
 IF c.intent_error IS NOT NULL OR c.intent_source_token IS NULL THEN RAISE EXCEPTION 'CAPTURE_INTENT_SOURCE_INVALID'; END IF;
 IF p->>'sourceToken' IS DISTINCT FROM c.intent_source_token THEN RAISE EXCEPTION 'CAPTURE_INTENT_SOURCE_CHANGED'; END IF;
 IF p->'source'->>'kind'='match' AND p->'source'->>'status'='VOID' AND p->'source'->>'startedAt' IS NULL AND COALESCE(p->'source'->'state','null'::jsonb)='null'::jsonb THEN p:=p||jsonb_build_object('excluded',true,'exclusionReason','CAPTURE_NOT_STARTED'); END IF;
 RETURN p;
END $$;
GRANT EXECUTE ON FUNCTION learning.project(text) TO capture_runtime;

ALTER FUNCTION learning.finish(text,text,bigint,text,text) RENAME TO finish_validated;
REVOKE ALL ON FUNCTION learning.finish_validated(text,text,bigint,text,text) FROM capture_runtime,PUBLIC;
CREATE FUNCTION learning.finish(cid text,w text,f bigint,body text,expected_source text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE p jsonb; doc jsonb; observed jsonb; BEGIN
 PERFORM 1 FROM learning.policy WHERE id FOR SHARE;
 PERFORM learning.require_lease(cid,w,f);
 p:=learning.project(cid);
 IF COALESCE((p->>'excluded')::boolean,false) THEN
  IF NOT (SELECT enabled FROM learning.policy WHERE id) OR expected_source IS DISTINCT FROM p->>'sourceToken' THEN RAISE EXCEPTION 'CAPTURE_EXCLUSION_FENCE'; END IF;
  UPDATE learning.captures SET state='excluded' WHERE capture_id=cid AND state='pending';
  UPDATE ops.outbox SET state='sent',payload=NULL,lease_owner=NULL,lease_until='epoch' WHERE outbox_id='learning.capture:'||cid;
  RETURN 'excluded';
 END IF;
 IF NOT COALESCE((p->>'suppressed')::boolean,false) THEN
  IF body IS NULL OR NOT(body IS JSON OBJECT) OR octet_length(body)>65536 THEN RAISE EXCEPTION 'CAPTURE_PAYLOAD_SHAPE'; END IF;
  doc:=body::jsonb;
  SELECT jsonb_agg(jsonb_build_object('b',e->'b','c',e->'c','player',e->'symbol') ORDER BY ord)
   INTO observed FROM jsonb_array_elements(doc->'moves') WITH ORDINALITY x(e,ord);
  IF COALESCE(observed,'[]') IS DISTINCT FROM p->'source'->'moves'
   OR doc->'game'->>'reason' IS DISTINCT FROM p->'source'->>'reason'
   OR doc->'game'->>'status' IS DISTINCT FROM p->'source'->>'status'
   OR doc->'game'->'rated' IS DISTINCT FROM p->'source'->'rated'
   OR doc->'game'->>'mode' IS DISTINCT FROM p->'source'->>'mode' THEN RAISE EXCEPTION 'CAPTURE_PAYLOAD_HISTORY_MISMATCH'; END IF;
 END IF;
 RETURN learning.finish_validated(cid,w,f,body,expected_source);
END $$;
GRANT EXECUTE ON FUNCTION learning.finish(text,text,bigint,text,text) TO capture_runtime;

CREATE FUNCTION learning.export_expiry_bound() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ BEGIN
 UPDATE learning.export_runs SET expires_at=LEAST(expires_at,(SELECT expires_at FROM learning.captures WHERE capture_id=NEW.capture_id)) WHERE run_id=NEW.run_id;
 RETURN NULL;
END $$;
CREATE TRIGGER export_member_expiry AFTER INSERT ON learning.export_members FOR EACH ROW EXECUTE FUNCTION learning.export_expiry_bound();

CREATE OR REPLACE FUNCTION learning.fixture_intents(rid text,fid text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$
DECLARE f tournament.fixtures%ROWTYPE; r tournament.rooms%ROWTYPE; p learning.policy%ROWTYPE; h jsonb; hints jsonb; actors text[]; idx integer:=0;
BEGIN
 SELECT * INTO p FROM learning.policy WHERE id;
 IF NOT p.enabled THEN RETURN 0; END IF;
 SELECT * INTO r FROM tournament.rooms WHERE room_id=rid;
 SELECT * INTO f FROM tournament.fixtures WHERE room_id=rid AND fixture_id=fid;
 IF NOT FOUND OR r.created_at<p.capture_after THEN RETURN 0; END IF;
 IF jsonb_typeof(f.history_json::jsonb)='array' THEN
  FOR h IN SELECT value FROM jsonb_array_elements(f.history_json::jsonb) LOOP
   idx:=idx+1;
   actors:=NULL; IF jsonb_typeof(h->'players')='array' THEN
    SELECT array_agg(value ORDER BY ord) INTO actors FROM jsonb_array_elements_text(h->'players') WITH ORDINALITY AS x(value,ord);
   END IF;
   hints:=jsonb_build_object('riskFlags',r.risk_flags);
   IF idx=jsonb_array_length(f.history_json::jsonb) AND (f.state_json::jsonb->'moves'=h->'moves' OR COALESCE(f.state_json::jsonb,'null'::jsonb)='null'::jsonb)
    AND jsonb_array_length(COALESCE(f.move_timings::jsonb,'[]'))=jsonb_array_length(h->'moves') THEN
    -- The last completed draw can clear state immediately but retains the last attempt timings.
    hints:=hints||jsonb_build_object('timings',f.move_timings,'endedAt',CASE WHEN f.status='DONE' THEN learning.ms(f.finished_at) ELSE NULL END,
     'lastMoveAt',learning.ms(f.last_move_at));
   END IF;
   PERFORM learning.enqueue('fixture',jsonb_build_array(rid,fid)::text,idx,actors,ARRAY['X','O'],hints);
  END LOOP;
 ELSE
  IF f.status='DONE' THEN PERFORM learning.enqueue('fixture',jsonb_build_array(rid,fid)::text,1,f.players,ARRAY['X','O'],jsonb_build_object('riskFlags',r.risk_flags)); END IF;
 END IF;
 IF r.status='VOID' AND r.settled AND f.status='PLAYING' AND f.state_json IS NOT NULL AND f.state_json->>'winner' IS NULL THEN
  PERFORM learning.enqueue('fixture',jsonb_build_array(rid,fid)::text,idx+1,f.players,ARRAY['X','O'],
   jsonb_build_object('riskFlags',r.risk_flags,'void',true,'timings',f.move_timings,'endedAt',learning.ms(r.ended_at),'lastMoveAt',learning.ms(f.last_move_at)));
 END IF;
 RETURN idx;
END $$;


CREATE OR REPLACE FUNCTION learning.metrics() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,learning,pg_temp AS $$
 SELECT jsonb_build_object('pending',count(*) FILTER(WHERE state='pending'),'sealed',count(*) FILTER(WHERE state='sealed'),
 'quarantined',count(*) FILTER(WHERE state='quarantined'),'excluded',count(*) FILTER(WHERE state='excluded'),
 'suppressed',count(*) FILTER(WHERE state='suppressed'),'purged',count(*) FILTER(WHERE state='purged'),
 'oldestPendingSeconds',COALESCE(extract(epoch FROM clock_timestamp()-min(intent_at) FILTER(WHERE state='pending')),0),
 'expiredUnpurged',count(*) FILTER(WHERE expires_at<=clock_timestamp() AND state NOT IN ('suppressed','purged'))) FROM learning.captures
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA learning FROM PUBLIC;
