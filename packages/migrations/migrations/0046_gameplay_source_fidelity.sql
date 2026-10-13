-- Follow-up acceptance hardening; original operational JSON types/grants remain unchanged.
-- Migration 0034 intentionally uses json (not jsonb) to preserve Unicode/source fidelity.
ALTER TABLE learning.policy ADD COLUMN split_seed text NOT NULL DEFAULT 'gameplay-opening6-v1-20261013';

CREATE OR REPLACE FUNCTION learning.source(cid text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$
DECLARE c learning.captures%ROWTYPE; m match.matches%ROWTYPE; f tournament.fixtures%ROWTYPE; r tournament.rooms%ROWTYPE;
 actors text[]; h jsonb; s jsonb; rid text; fid text; timings jsonb; flags text[];
BEGIN
 SELECT * INTO c FROM learning.captures WHERE capture_id=cid;
 IF NOT FOUND OR c.state IN ('suppressed','purged') THEN RETURN NULL; END IF;
 IF c.source_kind='match' THEN
  SELECT * INTO m FROM match.matches WHERE match_id=c.source_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF m.status<>'VOID' AND (m.receipt_reason #>> '{}') IS DISTINCT FROM (m.receipt_json->>'reason') THEN RAISE EXCEPTION 'CAPTURE_RECEIPT_CONFLICT'; END IF;
  SELECT array_agg(actor_id ORDER BY seat) INTO actors FROM match.participants WHERE match_id=m.match_id;
  s:=jsonb_build_object('kind','match','id',m.match_id,'attempt',0,'revision',m.revision,'status',m.status,'settled',m.settled,
   'mode',CASE WHEN m.source='direct' THEN CASE WHEN m.rated THEN 'direct-rated' ELSE 'direct-unrated' END ELSE CASE WHEN m.rated THEN 'ranked' ELSE 'casual' END END,
   'rated',m.rated,'clockSeconds',m.turn_seconds,'incrementSeconds',0,'players',actors,'symbols',jsonb_build_object('X',m.symbol_x,'O',m.symbol_y),
   'moves',m.state_json->'moves','state',m.state_json,'timings',m.move_timings,
   'winnerActor',CASE WHEN m.status='VOID' THEN NULL ELSE m.receipt_json->>'winner' END,
   'reason',CASE WHEN m.status='VOID' THEN 'void' ELSE m.receipt_reason #>> '{}' END,
   'startedAt',learning.ms(m.started_at),'endedAt',learning.ms(m.receipt_at),'lastMoveAt',learning.ms(m.last_move_at),'riskFlags',m.risk_flags,'historyOnly',false);
 ELSE
  rid:=c.source_id::jsonb->>0; fid:=c.source_id::jsonb->>1;
  SELECT * INTO f FROM tournament.fixtures WHERE room_id=rid AND fixture_id=fid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO r FROM tournament.rooms WHERE room_id=rid;
  IF COALESCE((c.hints->>'void')::boolean,false) THEN
   IF r.status<>'VOID' OR NOT r.settled OR f.state_json::jsonb IS NULL THEN RAISE EXCEPTION 'CAPTURE_FIXTURE_CONFLICT'; END IF;
   actors:=f.players; h:=jsonb_build_object('moves',f.state_json::jsonb->'moves','winner',NULL,'reason','void');
  ELSE
   h:=f.history_json::jsonb->(c.source_attempt-1);
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
   IF idx=jsonb_array_length(f.history_json::jsonb) AND (f.state_json::jsonb->'moves'=h->'moves' OR f.state_json IS NULL)
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

CREATE OR REPLACE FUNCTION learning.prune_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
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
  IF jsonb_typeof(OLD.history_json::jsonb)='array' AND NOT EXISTS(SELECT FROM tournament.fixtures WHERE room_id=OLD.room_id AND fixture_id=OLD.fixture_id) THEN
   IF EXISTS(SELECT FROM learning.policy p JOIN tournament.rooms r ON r.room_id=OLD.room_id WHERE p.id AND p.enabled AND r.created_at>=p.capture_after) AND EXISTS(SELECT FROM jsonb_array_elements(OLD.history_json::jsonb) WITH ORDINALITY h(value,idx)
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
    AND (history_json::jsonb->(c.source_attempt-1) IS NOT DISTINCT FROM OLD.history_json::jsonb->(c.source_attempt-1))
    AND (NOT COALESCE((c.hints->>'void')::boolean,false) OR state_json::jsonb IS NOT DISTINCT FROM OLD.state_json::jsonb)) INTO still_present;
  END IF;
  IF NOT still_present THEN RAISE EXCEPTION 'CAPTURE_SOURCE_STILL_REQUIRED'; END IF;
 END LOOP;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION learning.reconcile(k text,after_key text DEFAULT '',n integer DEFAULT 100,audit boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$
DECLARE row record; c record; p learning.policy%ROWTYPE; actors text[]; symbols text[]; scanned integer:=0; repaired integer:=0; cursor_key text:=after_key; cid text; rid text:=''; fid text:=''; had_intent boolean;
BEGIN
 IF k IS NULL OR after_key IS NULL OR k NOT IN ('match','fixture') OR n IS NULL OR n NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'CAPTURE_SCAN_ARGUMENT'; END IF;
 SELECT * INTO p FROM learning.policy WHERE id;
 IF NOT p.enabled THEN RAISE EXCEPTION 'CAPTURE_DISABLED'; END IF;
 IF k='match' THEN
  FOR row IN SELECT m.* FROM match.matches m WHERE m.match_id>after_key AND m.settled AND m.status IN ('FINISHED','VOID')
   AND COALESCE(m.receipt_at,m.started_at,m.created_at)>=p.capture_after ORDER BY m.match_id LIMIT n LOOP
   scanned:=scanned+1; cursor_key:=row.match_id;
   SELECT array_agg(actor_id ORDER BY seat),array_agg(CASE WHEN actor_id=row.symbol_x THEN 'X' ELSE 'O' END ORDER BY seat)
    INTO actors,symbols FROM match.participants WHERE match_id=row.match_id;
   cid:=learning.capture_id('match',row.match_id,0);
   SELECT EXISTS(SELECT FROM ops.outbox WHERE outbox_id='learning.capture:'||cid) INTO had_intent;
   PERFORM learning.enqueue('match',row.match_id,0,actors,symbols); repaired:=repaired+learning.repair_intent(cid,audit);
   IF NOT had_intent AND EXISTS(SELECT FROM ops.outbox WHERE outbox_id='learning.capture:'||cid) THEN repaired:=repaired+1; END IF;
  END LOOP;
 ELSE
  IF after_key<>'' THEN rid:=after_key::jsonb->>0;fid:=after_key::jsonb->>1;END IF;
  FOR row IN SELECT f.room_id,f.fixture_id FROM tournament.fixtures f JOIN tournament.rooms r USING(room_id)
   WHERE (f.room_id,f.fixture_id)>(rid,fid) AND r.created_at>=p.capture_after ORDER BY f.room_id,f.fixture_id LIMIT n LOOP
   scanned:=scanned+1;cursor_key:=jsonb_build_array(row.room_id,row.fixture_id)::text;
   PERFORM learning.fixture_intents(row.room_id,row.fixture_id);
   FOR c IN SELECT capture_id FROM learning.captures WHERE source_kind='fixture' AND source_id=cursor_key LOOP repaired:=repaired+learning.repair_intent(c.capture_id,audit); END LOOP;
  END LOOP;
 END IF;
 RETURN jsonb_build_object('scanned',scanned,'repaired',repaired,'next',cursor_key);
END $$;

CREATE OR REPLACE FUNCTION learning.begin_export(run uuid,key_name text,seed text,required_epoch bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE p learning.policy%ROWTYPE; high text; BEGIN
 SELECT * INTO p FROM learning.policy WHERE id FOR SHARE;
 IF NOT p.enabled OR required_epoch IS NULL OR required_epoch<>p.privacy_epoch THEN RAISE EXCEPTION 'CAPTURE_EXPORT_PRIVACY_FENCE'; END IF;
 IF seed IS NULL OR seed IS DISTINCT FROM p.split_seed THEN RAISE EXCEPTION 'CAPTURE_EXPORT_SPLIT_FROZEN'; END IF;
 SELECT max(capture_id) INTO high FROM learning.captures WHERE state='sealed' AND expires_at>clock_timestamp();
 INSERT INTO learning.export_runs(run_id,state,expires_at,privacy_epoch,policy_version,high_water,key_id,split_seed)
 VALUES(run,'building',clock_timestamp()+make_interval(days=>p.export_retention_days),p.privacy_epoch,p.policy_version,high,key_name,seed);
 RETURN jsonb_build_object('highWater',high,'privacyEpoch',p.privacy_epoch,'policyVersion',p.policy_version);
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA learning FROM PUBLIC;
