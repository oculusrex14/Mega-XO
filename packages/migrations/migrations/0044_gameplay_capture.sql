-- runner: current-role
-- DC03/DC04: additive private gameplay archive. Nothing is enabled by migration.
-- Separate exact identities; no API/economy grant changes. Trusted runner only, as in 0001.
DO $$ DECLARE r text; BEGIN
 IF session_user <> 'migration_owner' AND NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname=session_user),false)
 AND NOT (COALESCE((SELECT rolcreaterole FROM pg_roles WHERE rolname=session_user),false)
 AND (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database())=session_user) THEN
  RAISE EXCEPTION 'CAPTURE_PRIVILEGED_MIGRATION_REQUIRED' USING ERRCODE='42501';
 END IF;
 FOREACH r IN ARRAY ARRAY['capture_runtime','capture_exporter','capture_privacy'] LOOP
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',r);
  END IF;
  -- PG16 auto-grants ADMIN OPTION to the CREATEROLE principal that creates a role; re-granting
  -- it back to the same (own-grantor) session fails with 0LP01. Mirror 0001's idempotent guard so
  -- the grant is made only when migration_owner does not already hold the membership.
  IF NOT EXISTS(SELECT FROM pg_auth_members
                 WHERE roleid=r::regrole AND member='migration_owner'::regrole AND admin_option) THEN
   EXECUTE format('GRANT %I TO migration_owner WITH ADMIN OPTION',r);
  END IF;
 END LOOP;
END $$;
CREATE SCHEMA learning AUTHORIZATION v5_owner;
GRANT USAGE ON SCHEMA learning TO migration_owner;
SET LOCAL ROLE v5_owner;
REVOKE ALL ON SCHEMA learning FROM PUBLIC;
GRANT USAGE ON SCHEMA learning TO capture_runtime,capture_exporter,capture_privacy;
ALTER DEFAULT PRIVILEGES IN SCHEMA learning REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Approval refs are operator receipts, not an assertion of legal approval by this migration.
CREATE TABLE learning.policy (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), enabled boolean NOT NULL DEFAULT false,
 policy_version text, approval_ref text, encryption_ref text, choice_ref text,
 capture_after timestamptz, retention_days integer CHECK(retention_days>0),
 export_retention_days integer CHECK(export_retention_days>0), backup_retention_days integer CHECK(backup_retention_days>0),
 source_commit text CHECK(source_commit ~ '^[a-f0-9]{40}$'), rules_hash text CHECK(rules_hash ~ '^[a-f0-9]{64}$'),
 environment text CHECK(environment IN ('test','staging','production')),
 privacy_epoch bigint NOT NULL DEFAULT 0 CHECK(privacy_epoch>=0),
 CHECK(NOT enabled OR (policy_version IS NOT NULL AND length(policy_version) BETWEEN 1 AND 120
  AND approval_ref IS NOT NULL AND encryption_ref IS NOT NULL AND choice_ref IS NOT NULL
  AND length(approval_ref)>0 AND length(encryption_ref)>0 AND length(choice_ref)>0
  AND capture_after IS NOT NULL AND retention_days IS NOT NULL AND export_retention_days IS NOT NULL
  AND backup_retention_days IS NOT NULL AND source_commit IS NOT NULL AND rules_hash IS NOT NULL AND environment IS NOT NULL))
);
INSERT INTO learning.policy(id) VALUES(true);
CREATE TABLE learning.captures (
 capture_id text PRIMARY KEY CHECK(capture_id ~ '^[a-f0-9]{64}$'),
 source_kind text NOT NULL CHECK(source_kind IN ('match','fixture')),
 source_id text NOT NULL CHECK(length(source_id) BETWEEN 1 AND 400), source_attempt integer NOT NULL CHECK(source_attempt BETWEEN 0 AND 10000),
 policy_version text NOT NULL, source_commit text NOT NULL CHECK(source_commit ~ '^[a-f0-9]{40}$'),
 rules_hash text NOT NULL CHECK(rules_hash ~ '^[a-f0-9]{64}$'), environment text NOT NULL CHECK(environment IN ('test','staging','production')),
 intent_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, sealed_at timestamptz,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sealed','quarantined','suppressed','purged')),
 hints jsonb NOT NULL DEFAULT '{}' CHECK(pg_column_size(hints)<=32768),
 payload text CHECK(payload IS NULL OR (octet_length(payload)<=65536 AND payload IS JSON OBJECT)),
 payload_sha256 text CHECK(payload_sha256 IS NULL OR payload_sha256 ~ '^[a-f0-9]{64}$'), source_token text,
 UNIQUE(source_kind,source_id,source_attempt),
 CHECK(state<>'sealed' OR (payload IS NOT NULL AND payload_sha256 IS NOT NULL AND source_token IS NOT NULL AND sealed_at IS NOT NULL)),
 CHECK(payload IS NULL OR payload_sha256=encode(sha256(convert_to(payload,'UTF8')),'hex')),
 CHECK(payload IS NULL OR (payload::jsonb->>'format'='game-capture/v1'
  AND jsonb_typeof(payload::jsonb->'moves')='array'
  AND jsonb_array_length(payload::jsonb->'moves') BETWEEN 0 AND 81))
);
CREATE INDEX capture_pending_age ON learning.captures(intent_at,capture_id) WHERE state='pending';
CREATE INDEX capture_retention ON learning.captures(expires_at) WHERE state NOT IN ('purged','suppressed');
CREATE TABLE learning.capture_subjects (
 capture_id text NOT NULL REFERENCES learning.captures(capture_id), actor_id text NOT NULL,
 seat smallint NOT NULL CHECK(seat IN (0,1)), symbol text CHECK(symbol IN ('X','O')),
 PRIMARY KEY(capture_id,seat), UNIQUE(capture_id,actor_id), UNIQUE(capture_id,symbol)
);
CREATE INDEX capture_subject_lookup ON learning.capture_subjects(actor_id,capture_id);
CREATE TABLE learning.rejections (
 capture_id text PRIMARY KEY REFERENCES learning.captures(capture_id),
 code text NOT NULL CHECK(code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
 first_at timestamptz NOT NULL DEFAULT clock_timestamp(), last_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 occurrences bigint NOT NULL DEFAULT 1 CHECK(occurrences>0)
);
CREATE TABLE learning.suppressions (
 actor_id text PRIMARY KEY CHECK(length(actor_id) BETWEEN 1 AND 160),
 reason text NOT NULL CHECK(reason IN ('account-deletion','user-choice')),
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(), epoch bigint NOT NULL CHECK(epoch>0)
);
CREATE TABLE learning.erasure_tombstones (
 capture_id text PRIMARY KEY CHECK(capture_id ~ '^[a-f0-9]{64}$'), erased_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE learning.subject_classes (
 actor_id text PRIMARY KEY, classification text NOT NULL CHECK(classification IN ('human','server-bot','test-fixture','unknown')),
 evidence_ref text NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 240)
);
CREATE TABLE learning.export_runs (
 run_id uuid PRIMARY KEY, state text NOT NULL CHECK(state IN ('building','ready','revoked','failed','purged')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 privacy_epoch bigint NOT NULL, policy_version text NOT NULL, high_water text,
 key_id text NOT NULL CHECK(length(key_id) BETWEEN 1 AND 120), split_seed text NOT NULL CHECK(length(split_seed) BETWEEN 1 AND 120),
 manifest jsonb, CHECK(manifest IS NULL OR pg_column_size(manifest)<=65536)
);
CREATE TABLE learning.export_members (
 run_id uuid NOT NULL REFERENCES learning.export_runs(run_id), capture_id text NOT NULL REFERENCES learning.captures(capture_id),
 PRIMARY KEY(run_id,capture_id)
);
CREATE INDEX export_reverse_lineage ON learning.export_members(capture_id,run_id);

CREATE FUNCTION learning.capture_id(k text,i text,a integer) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
 SELECT encode(sha256(convert_to(k||':'||length(i)::text||':'||i||':'||a::text,'UTF8')),'hex')
$$;
CREATE FUNCTION learning.ms(t timestamptz) RETURNS bigint LANGUAGE sql IMMUTABLE STRICT
SET search_path=pg_catalog,pg_temp AS $$ SELECT floor(extract(epoch FROM t)*1000)::bigint $$;
CREATE FUNCTION learning.immutable_capture() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,learning,pg_temp AS $$ BEGIN
 IF (NEW.capture_id,NEW.source_kind,CASE WHEN NEW.state IN ('suppressed','purged') AND NEW.source_id=OLD.capture_id THEN OLD.source_id ELSE NEW.source_id END,NEW.source_attempt,NEW.policy_version,NEW.source_commit,NEW.rules_hash,NEW.environment,NEW.intent_at,NEW.expires_at)
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
CREATE TRIGGER capture_immutable BEFORE UPDATE ON learning.captures FOR EACH ROW EXECUTE FUNCTION learning.immutable_capture();

-- Raw actor ids never enter the public-shaped body or outbox. The private reverse index is required
-- even while a job is pending, so deletion before worker consumption cannot recreate erased data.
CREATE FUNCTION learning.enqueue(k text,i text,a integer,players text[],symbols text[],h jsonb DEFAULT '{}') RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,learning,pg_temp AS $$
DECLARE p learning.policy%ROWTYPE; cid text; n integer; blocked boolean;
BEGIN
 SELECT * INTO p FROM learning.policy WHERE id;
 IF NOT p.enabled THEN RETURN NULL; END IF;
 cid:=learning.capture_id(k,i,a);
 IF EXISTS(SELECT FROM learning.erasure_tombstones WHERE capture_id=cid) THEN RETURN cid; END IF;
 INSERT INTO learning.captures(capture_id,source_kind,source_id,source_attempt,policy_version,source_commit,rules_hash,environment,intent_at,expires_at,hints)
 VALUES(cid,k,i,a,p.policy_version,p.source_commit,p.rules_hash,p.environment,clock_timestamp(),clock_timestamp()+make_interval(days=>p.retention_days),h)
 ON CONFLICT(capture_id) DO NOTHING;
 -- Idempotent reprocessing does not reset a sealed/purged record or its approved retention clock.
 IF (SELECT state FROM learning.captures WHERE capture_id=cid)<>'pending' THEN RETURN cid; END IF;
 IF cardinality(players)=2 AND players[1]<>players[2] THEN
  FOR n IN 1..2 LOOP
   INSERT INTO learning.capture_subjects(capture_id,actor_id,seat,symbol) VALUES(cid,players[n],n-1,CASE WHEN symbols[1] IS DISTINCT FROM symbols[2] THEN symbols[n] ELSE NULL END) ON CONFLICT DO NOTHING;
  END LOOP;
 END IF;
 SELECT EXISTS(SELECT FROM learning.suppressions WHERE actor_id=ANY(players)) INTO blocked;
 IF blocked THEN
  INSERT INTO learning.erasure_tombstones(capture_id) VALUES(cid) ON CONFLICT DO NOTHING;
  UPDATE learning.captures SET state='suppressed',source_id=cid,hints='{}' WHERE capture_id=cid;
  DELETE FROM learning.capture_subjects WHERE capture_id=cid;
  RETURN cid;
 END IF;
 INSERT INTO ops.outbox(outbox_id,kind,payload,state,created_at,expires_at,next_at,lease_until,attempts)
 VALUES('learning.capture:'||cid,'learning.capture',jsonb_build_object('version',1,'payload',jsonb_build_object('captureId',cid),'businessKey',cid)::text,
 'queued',clock_timestamp(),'infinity',clock_timestamp(),'epoch',0) ON CONFLICT(outbox_id) DO NOTHING;
 RETURN cid;
END $$;

CREATE FUNCTION learning.match_intent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$
DECLARE p learning.policy%ROWTYPE; actors text[]; symbols text[];
BEGIN
 SELECT * INTO p FROM learning.policy WHERE id;
 IF NOT p.enabled OR COALESCE(NEW.receipt_at,NEW.started_at,NEW.created_at)<p.capture_after THEN RETURN NULL; END IF;
 SELECT array_agg(actor_id ORDER BY seat),array_agg(CASE WHEN actor_id=NEW.symbol_x THEN 'X' ELSE 'O' END ORDER BY seat)
 INTO actors,symbols FROM match.participants WHERE match_id=NEW.match_id;
 -- Offered voids have no actual game/symbols; retain an explicit excluded/quarantine obligation.
 PERFORM learning.enqueue('match',NEW.match_id,0,actors,symbols);
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER learning_match_terminal AFTER INSERT OR UPDATE ON match.matches
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.settled AND NEW.status IN ('FINISHED','VOID')) EXECUTE FUNCTION learning.match_intent();

-- History ordinal is stable across drawn rematches even when fixture.attempt resets. Freeze only
-- the metadata that later room saves overwrite; moves stay in the authoritative history_json.
CREATE FUNCTION learning.fixture_intents(rid text,fid text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$
DECLARE f tournament.fixtures%ROWTYPE; r tournament.rooms%ROWTYPE; p learning.policy%ROWTYPE; h jsonb; hints jsonb; actors text[]; idx integer:=0;
BEGIN
 SELECT * INTO p FROM learning.policy WHERE id;
 IF NOT p.enabled THEN RETURN 0; END IF;
 SELECT * INTO r FROM tournament.rooms WHERE room_id=rid;
 SELECT * INTO f FROM tournament.fixtures WHERE room_id=rid AND fixture_id=fid;
 IF NOT FOUND OR r.created_at<p.capture_after THEN RETURN 0; END IF;
 IF jsonb_typeof(f.history_json)='array' THEN
  FOR h IN SELECT value FROM jsonb_array_elements(f.history_json) LOOP
   idx:=idx+1;
   SELECT array_agg(value ORDER BY ord) INTO actors FROM jsonb_array_elements_text(h->'players') WITH ORDINALITY AS x(value,ord);
   hints:=jsonb_build_object('riskFlags',r.risk_flags);
   IF idx=jsonb_array_length(f.history_json) AND (f.state_json->'moves'=h->'moves' OR f.state_json IS NULL) THEN
    -- The last completed draw can clear state immediately but retains the last attempt timings.
    hints:=hints||jsonb_build_object('timings',f.move_timings,'endedAt',CASE WHEN f.status='DONE' THEN learning.ms(f.finished_at) ELSE NULL END,
     'lastMoveAt',learning.ms(f.last_move_at));
   END IF;
   PERFORM learning.enqueue('fixture',jsonb_build_array(rid,fid)::text,idx,actors,ARRAY['X','O'],hints);
  END LOOP;
 END IF;
 IF r.status='VOID' AND r.settled AND f.status='PLAYING' AND f.state_json IS NOT NULL THEN
  PERFORM learning.enqueue('fixture',jsonb_build_array(rid,fid)::text,idx+1,f.players,ARRAY['X','O'],
   jsonb_build_object('riskFlags',r.risk_flags,'void',true,'timings',f.move_timings,'endedAt',learning.ms(r.ended_at),'lastMoveAt',learning.ms(f.last_move_at)));
 END IF;
 RETURN idx;
END $$;
CREATE FUNCTION learning.fixture_intent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ BEGIN
 PERFORM learning.fixture_intents(NEW.room_id,NEW.fixture_id); RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER learning_fixture_terminal AFTER INSERT OR UPDATE ON tournament.fixtures
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION learning.fixture_intent();
CREATE FUNCTION learning.room_void_intent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE f record; BEGIN
 FOR f IN SELECT fixture_id FROM tournament.fixtures WHERE room_id=NEW.room_id LOOP PERFORM learning.fixture_intents(NEW.room_id,f.fixture_id); END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER learning_room_void AFTER INSERT OR UPDATE ON tournament.rooms
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.status='VOID' AND NEW.settled) EXECUTE FUNCTION learning.room_void_intent();

-- Only these gameplay fields may cross the privileged boundary. No profiles, credentials,
-- wallets, financial receipt amounts, precise locations, IPs, or opaque extras are projected.
CREATE FUNCTION learning.source(cid text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$
DECLARE c learning.captures%ROWTYPE; m match.matches%ROWTYPE; f tournament.fixtures%ROWTYPE; r tournament.rooms%ROWTYPE;
 actors text[]; h jsonb; s jsonb; rid text; fid text; timings jsonb; flags text[];
BEGIN
 SELECT * INTO c FROM learning.captures WHERE capture_id=cid;
 IF NOT FOUND OR c.state IN ('suppressed','purged') THEN RETURN NULL; END IF;
 IF c.source_kind='match' THEN
  SELECT * INTO m FROM match.matches WHERE match_id=c.source_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF m.status<>'VOID' AND m.receipt_reason IS DISTINCT FROM m.receipt_json->>'reason' THEN RAISE EXCEPTION 'CAPTURE_RECEIPT_CONFLICT'; END IF;
  SELECT array_agg(actor_id ORDER BY seat) INTO actors FROM match.participants WHERE match_id=m.match_id;
  s:=jsonb_build_object('kind','match','id',m.match_id,'attempt',0,'revision',m.revision,'status',m.status,'settled',m.settled,
   'mode',CASE WHEN m.source='direct' THEN CASE WHEN m.rated THEN 'direct-rated' ELSE 'direct-unrated' END ELSE CASE WHEN m.rated THEN 'ranked' ELSE 'casual' END END,
   'rated',m.rated,'clockSeconds',m.turn_seconds,'incrementSeconds',0,'players',actors,'symbols',jsonb_build_object('X',m.symbol_x,'O',m.symbol_y),
   'moves',m.state_json->'moves','state',m.state_json,'timings',m.move_timings,
   'winnerActor',CASE WHEN m.status='VOID' THEN NULL ELSE m.receipt_json->>'winner' END,
   'reason',CASE WHEN m.status='VOID' THEN 'void' ELSE m.receipt_reason END,
   'startedAt',learning.ms(m.started_at),'endedAt',learning.ms(m.receipt_at),'lastMoveAt',learning.ms(m.last_move_at),'riskFlags',m.risk_flags,'historyOnly',false);
 ELSE
  rid:=c.source_id::jsonb->>0; fid:=c.source_id::jsonb->>1;
  SELECT * INTO f FROM tournament.fixtures WHERE room_id=rid AND fixture_id=fid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO r FROM tournament.rooms WHERE room_id=rid;
  IF COALESCE((c.hints->>'void')::boolean,false) THEN
   IF r.status<>'VOID' OR NOT r.settled OR f.state_json IS NULL THEN RAISE EXCEPTION 'CAPTURE_FIXTURE_CONFLICT'; END IF;
   actors:=f.players; h:=jsonb_build_object('moves',f.state_json->'moves','winner',NULL,'reason','void');
  ELSE
   h:=f.history_json->(c.source_attempt-1);
   IF h IS NULL THEN RETURN NULL; END IF;
   SELECT array_agg(value ORDER BY ord) INTO actors FROM jsonb_array_elements_text(h->'players') WITH ORDINALITY AS x(value,ord);
  END IF;
  s:=jsonb_build_object('kind','fixture','id',c.source_id,'attempt',c.source_attempt,'revision',jsonb_array_length(h->'moves'),
   'status',CASE WHEN h->>'reason'='void' THEN 'VOID' ELSE 'FINISHED' END,'settled',true,'mode','tournament','rated',false,
   'clockSeconds',r.clock_seconds,'incrementSeconds',r.increment_seconds,'players',actors,'symbols',jsonb_build_object('X',actors[1],'O',actors[2]),
   'moves',h->'moves','state',NULL,'timings',c.hints->'timings','winnerActor',h->>'winner','reason',h->>'reason',
   'startedAt',NULL,'endedAt',c.hints->'endedAt','lastMoveAt',c.hints->'lastMoveAt','riskFlags',c.hints->'riskFlags','historyOnly',true);
 END IF;
 RETURN s;
END $$;
CREATE FUNCTION learning.configuration() RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$
 SELECT jsonb_build_object('enabled',enabled,'policyVersion',policy_version,'privacyEpoch',privacy_epoch,'rulesHash',rules_hash,'environment',environment) FROM learning.policy WHERE id
$$;
CREATE FUNCTION learning.project(cid text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$
DECLARE c learning.captures%ROWTYPE; s jsonb; pop text;
BEGIN
 SELECT * INTO c FROM learning.captures WHERE capture_id=cid;
 IF NOT FOUND THEN RAISE EXCEPTION 'CAPTURE_UNKNOWN'; END IF;
 IF EXISTS(SELECT FROM learning.capture_subjects x JOIN learning.suppressions z USING(actor_id) WHERE x.capture_id=cid) THEN RETURN jsonb_build_object('suppressed',true); END IF;
 IF c.state IN ('suppressed','purged') OR c.expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('suppressed',true); END IF;
 s:=learning.source(cid);
 pop:=CASE WHEN c.environment<>'production' THEN 'test-fixture'
  WHEN (SELECT count(*) FROM learning.capture_subjects x JOIN learning.subject_classes z USING(actor_id) WHERE x.capture_id=cid AND z.classification='human')=2 THEN 'human-v-human'
  WHEN EXISTS(SELECT FROM learning.capture_subjects x JOIN learning.subject_classes z USING(actor_id) WHERE x.capture_id=cid AND z.classification IN ('server-bot','test-fixture')) THEN 'server-bot' ELSE 'unknown' END;
 RETURN jsonb_build_object('source',s,'sourceToken',CASE WHEN s IS NULL THEN NULL ELSE encode(sha256(convert_to(s::text,'UTF8')),'hex') END,
  'rulesHash',c.rules_hash,'sourceCommit',c.source_commit,'environment',c.environment,'population',pop);
END $$;

-- A pruning guard runs at transaction end: tournament persistence legitimately DELETEs then
-- INSERTs all fixtures in a room. Checking before the INSERT would break ordinary gameplay.
CREATE FUNCTION learning.prune_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$
DECLARE c record; sid text; still_present boolean;
BEGIN
 IF TG_TABLE_SCHEMA='match' THEN sid:=OLD.match_id;
 ELSE sid:=jsonb_build_array(OLD.room_id,OLD.fixture_id)::text; END IF;
 IF TG_TABLE_SCHEMA='match' THEN
 IF OLD.settled AND OLD.status IN ('FINISHED','VOID')
 AND EXISTS(SELECT FROM learning.policy WHERE id AND enabled AND COALESCE(OLD.receipt_at,OLD.started_at,OLD.created_at)>=capture_after)
 AND NOT EXISTS(SELECT FROM match.matches WHERE match_id=sid)
 AND NOT EXISTS(SELECT FROM learning.captures WHERE capture_id=learning.capture_id('match',sid,0))
 AND NOT EXISTS(SELECT FROM learning.erasure_tombstones WHERE capture_id=learning.capture_id('match',sid,0))
 AND NOT EXISTS(SELECT FROM learning.suppressions WHERE actor_id IN (OLD.symbol_x,OLD.symbol_y)) THEN
  RAISE EXCEPTION 'CAPTURE_UNREGISTERED_SOURCE';
 END IF;
 ELSE
  IF jsonb_typeof(OLD.history_json)='array' AND NOT EXISTS(SELECT FROM tournament.fixtures WHERE room_id=OLD.room_id AND fixture_id=OLD.fixture_id) THEN
   IF EXISTS(SELECT FROM learning.policy WHERE id AND enabled) AND EXISTS(SELECT FROM jsonb_array_elements(OLD.history_json) WITH ORDINALITY h(value,idx)
    WHERE NOT EXISTS(SELECT FROM learning.captures x WHERE x.capture_id=learning.capture_id('fixture',sid,h.idx::integer))
    AND NOT EXISTS(SELECT FROM learning.erasure_tombstones x WHERE x.capture_id=learning.capture_id('fixture',sid,h.idx::integer))
    AND NOT EXISTS(SELECT FROM learning.suppressions z WHERE z.actor_id IN(SELECT jsonb_array_elements_text(h.value->'players')))) THEN RAISE EXCEPTION 'CAPTURE_UNREGISTERED_SOURCE'; END IF;
  END IF;
 END IF;
 FOR c IN SELECT * FROM learning.captures WHERE source_id=sid AND source_kind=CASE WHEN TG_TABLE_SCHEMA='match' THEN 'match' ELSE 'fixture' END AND state IN ('pending','quarantined') LOOP
  IF EXISTS(SELECT FROM learning.capture_subjects x JOIN learning.suppressions z USING(actor_id) WHERE x.capture_id=c.capture_id) THEN CONTINUE; END IF;
  IF TG_TABLE_SCHEMA='match' THEN
   SELECT EXISTS(SELECT FROM match.matches WHERE match_id=sid) INTO still_present;
  ELSE
   SELECT EXISTS(SELECT FROM tournament.fixtures WHERE room_id=OLD.room_id AND fixture_id=OLD.fixture_id
    AND (history_json->(c.source_attempt-1) IS NOT DISTINCT FROM OLD.history_json->(c.source_attempt-1))
    AND (NOT COALESCE((c.hints->>'void')::boolean,false) OR state_json IS NOT DISTINCT FROM OLD.state_json)) INTO still_present;
  END IF;
  IF NOT still_present THEN RAISE EXCEPTION 'CAPTURE_SOURCE_STILL_REQUIRED'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER learning_match_prune AFTER DELETE ON match.matches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION learning.prune_guard();
CREATE CONSTRAINT TRIGGER learning_fixture_prune AFTER DELETE ON tournament.fixtures DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION learning.prune_guard();
REVOKE ALL ON ALL TABLES IN SCHEMA learning FROM PUBLIC,api_runtime,core_runtime,worker_runtime,capture_runtime,capture_exporter,capture_privacy;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA learning FROM PUBLIC;
GRANT EXECUTE ON FUNCTION learning.configuration() TO capture_runtime,capture_exporter,capture_privacy;
GRANT EXECUTE ON FUNCTION learning.project(text) TO capture_runtime;
