-- DC05-DC09: private fenced workers, reconciliation, erasure, and export lineage.
-- All SECURITY DEFINER functions fix search_path and are denied to PUBLIC in this transaction.
CREATE FUNCTION learning.claim(w text,n integer DEFAULT 8,lease_ms integer DEFAULT 30000)
RETURNS TABLE(capture_id text,lease_token bigint) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ BEGIN
 IF w IS NULL OR w !~ '^[A-Za-z0-9:_-]{1,120}$' OR n IS NULL OR n NOT BETWEEN 1 AND 100 OR lease_ms IS NULL OR lease_ms NOT BETWEEN 1000 AND 600000 THEN RAISE EXCEPTION 'CAPTURE_CLAIM_ARGUMENT'; END IF;
 IF NOT (SELECT enabled FROM learning.policy WHERE id) THEN RETURN; END IF;
 RETURN QUERY WITH due AS (
  SELECT o.outbox_id FROM ops.outbox o JOIN learning.captures c ON o.outbox_id='learning.capture:'||c.capture_id
  WHERE o.kind='learning.capture' AND c.state='pending' AND c.expires_at>clock_timestamp()
   AND ((o.state='queued' AND o.next_at<=clock_timestamp()) OR (o.state='sending' AND o.lease_until<=clock_timestamp()))
  ORDER BY o.next_at,o.outbox_id LIMIT n FOR UPDATE OF o SKIP LOCKED
 ) UPDATE ops.outbox o SET state='sending',lease_owner=w,lease_token=COALESCE(o.lease_token,0)+1,
   lease_until=clock_timestamp()+make_interval(secs=>lease_ms/1000.0),attempts=o.attempts+1
 FROM due WHERE o.outbox_id=due.outbox_id RETURNING substring(o.outbox_id FROM 18),o.lease_token;
END $$;

CREATE FUNCTION learning.require_lease(cid text,w text,f bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ BEGIN
 PERFORM 1 FROM ops.outbox WHERE outbox_id='learning.capture:'||cid AND kind='learning.capture'
  AND state='sending' AND lease_owner=w AND lease_token=f AND lease_until>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CAPTURE_STALE_LEASE'; END IF;
END $$;
CREATE FUNCTION learning.quarantine(cid text,err text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ BEGIN
 IF err IS NULL OR err !~ '^[A-Z][A-Z0-9_]{0,79}$' THEN RAISE EXCEPTION 'CAPTURE_ERROR_CODE'; END IF;
 UPDATE learning.captures SET state='quarantined' WHERE capture_id=cid AND state NOT IN ('purged','suppressed');
 INSERT INTO learning.rejections(capture_id,code) VALUES(cid,err) ON CONFLICT(capture_id)
  DO UPDATE SET code=EXCLUDED.code,last_at=clock_timestamp(),occurrences=learning.rejections.occurrences+1;
 -- Conservatively invalidate even in-flight exports; no exposed dataset can outlive a conflict.
 UPDATE learning.export_runs SET state='revoked' WHERE state IN ('building','ready');
END $$;
CREATE FUNCTION learning.finish(cid text,w text,f bigint,body text,expected_source text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$
DECLARE c learning.captures%ROWTYPE; doc jsonb; projection jsonb; p learning.policy%ROWTYPE; result text;
BEGIN
 SELECT * INTO p FROM learning.policy WHERE id FOR SHARE;
 IF NOT p.enabled THEN RAISE EXCEPTION 'CAPTURE_DISABLED'; END IF;
 PERFORM learning.require_lease(cid,w,f);
 SELECT * INTO c FROM learning.captures WHERE capture_id=cid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CAPTURE_UNKNOWN'; END IF;
 projection:=learning.project(cid);
 IF COALESCE((projection->>'suppressed')::boolean,false) THEN
  IF c.state NOT IN ('suppressed','purged') THEN UPDATE learning.captures SET state='suppressed',source_id=cid,payload=NULL,payload_sha256=NULL,source_token=NULL,hints='{}' WHERE capture_id=cid; END IF;
  INSERT INTO learning.erasure_tombstones(capture_id) VALUES(cid) ON CONFLICT DO NOTHING;
  DELETE FROM learning.capture_subjects WHERE capture_id=cid; result:='suppressed';
 ELSIF expected_source IS NULL OR projection->>'sourceToken' IS DISTINCT FROM expected_source THEN
  PERFORM learning.quarantine(cid,'CAPTURE_SOURCE_CHANGED'); result:='quarantined';
 ELSE
  IF body IS NULL OR octet_length(body)>65536 OR NOT (body IS JSON OBJECT) THEN RAISE EXCEPTION 'CAPTURE_PAYLOAD_SHAPE'; END IF;
  doc:=body::jsonb;
  IF doc->>'format' IS DISTINCT FROM 'game-capture/v1'
   OR doc->'source'->>'kind' IS DISTINCT FROM c.source_kind OR doc->'source'->>'id' IS DISTINCT FROM c.source_id
   OR (doc->'source'->>'attempt')::integer IS DISTINCT FROM c.source_attempt
   OR doc->'rules'->>'sha256' IS DISTINCT FROM c.rules_hash
   OR doc->'provenance'->>'sourceCommit' IS DISTINCT FROM c.source_commit
   OR doc->'provenance'->>'environment' IS DISTINCT FROM c.environment
   OR doc->'provenance'->>'population' IS DISTINCT FROM projection->>'population'
   OR jsonb_array_length(doc->'moves') IS DISTINCT FROM (projection->'source'->>'revision')::integer
   OR (SELECT count(*) FROM learning.capture_subjects WHERE capture_id=cid)<>2 THEN RAISE EXCEPTION 'CAPTURE_PAYLOAD_BINDING'; END IF;
  IF c.payload IS NOT NULL AND (c.payload<>body OR c.source_token<>expected_source) THEN
   PERFORM learning.quarantine(cid,'CAPTURE_IMMUTABLE_CONFLICT'); result:='quarantined';
  ELSE
   UPDATE learning.captures SET state='sealed',payload=body,payload_sha256=encode(sha256(convert_to(body,'UTF8')),'hex'),
    source_token=expected_source,sealed_at=COALESCE(sealed_at,clock_timestamp()) WHERE capture_id=cid;
   result:='sealed';
  END IF;
 END IF;
 UPDATE ops.outbox SET state='sent',payload=NULL,lease_owner=NULL,lease_until='epoch' WHERE outbox_id='learning.capture:'||cid;
 RETURN result;
END $$;
CREATE FUNCTION learning.reject(cid text,w text,f bigint,err text,retry boolean DEFAULT false) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE attempts_now integer; BEGIN
 PERFORM learning.require_lease(cid,w,f);
 SELECT attempts INTO attempts_now FROM ops.outbox WHERE outbox_id='learning.capture:'||cid;
 IF retry AND attempts_now<10 THEN
  UPDATE ops.outbox SET state='queued',lease_owner=NULL,lease_until='epoch',next_at=clock_timestamp()+make_interval(secs=>LEAST(300,power(2,attempts_now)::integer)) WHERE outbox_id='learning.capture:'||cid;
  RETURN 'retry';
 END IF;
 PERFORM learning.quarantine(cid,CASE WHEN retry THEN 'CAPTURE_RETRY_EXHAUSTED' ELSE err END);
 UPDATE ops.outbox SET state='failed',payload=NULL,lease_owner=NULL,lease_until='epoch' WHERE outbox_id='learning.capture:'||cid;
 RETURN 'quarantined';
END $$;

CREATE FUNCTION learning.repair_intent(cid text,audit boolean DEFAULT false) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE c learning.captures%ROWTYPE; s jsonb; n integer; BEGIN
 SELECT * INTO c FROM learning.captures WHERE capture_id=cid;
 IF c.state='sealed' AND audit THEN
  BEGIN
   s:=learning.source(cid);
   IF s IS NULL OR encode(sha256(convert_to(s::text,'UTF8')),'hex')<>c.source_token THEN PERFORM learning.quarantine(cid,'CAPTURE_SOURCE_DRIFT'); END IF;
  EXCEPTION WHEN OTHERS THEN PERFORM learning.quarantine(cid,'CAPTURE_SOURCE_DRIFT'); END;
 END IF;
 IF c.capture_id IS NULL OR c.state<>'pending' OR c.expires_at<=clock_timestamp() THEN RETURN 0; END IF;
 INSERT INTO ops.outbox(outbox_id,kind,payload,state,created_at,expires_at,next_at,lease_until,attempts)
 VALUES('learning.capture:'||cid,'learning.capture',jsonb_build_object('version',1,'payload',jsonb_build_object('captureId',cid),'businessKey',cid)::text,'queued',clock_timestamp(),'infinity',clock_timestamp(),'epoch',0)
 ON CONFLICT(outbox_id) DO UPDATE SET state='queued',payload=EXCLUDED.payload,next_at=clock_timestamp(),expires_at='infinity',lease_owner=NULL,lease_until='epoch'
 WHERE ops.outbox.state IN ('sent','expired','failed','cancelled');
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n;
END $$;
CREATE FUNCTION learning.reconcile(k text,after_key text DEFAULT '',n integer DEFAULT 100,audit boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$
DECLARE row record; c record; p learning.policy%ROWTYPE; actors text[]; symbols text[]; scanned integer:=0; repaired integer:=0; cursor_key text:=after_key; cid text; rid text:=''; fid text:='';
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
   cid:=learning.enqueue('match',row.match_id,0,actors,symbols); repaired:=repaired+learning.repair_intent(cid,audit);
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
CREATE FUNCTION learning.metrics() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,learning,pg_temp AS $$
 SELECT jsonb_build_object('pending',count(*) FILTER(WHERE state='pending'),'sealed',count(*) FILTER(WHERE state='sealed'),
 'quarantined',count(*) FILTER(WHERE state='quarantined'),'suppressed',count(*) FILTER(WHERE state='suppressed'),'purged',count(*) FILTER(WHERE state='purged'),
 'oldestPendingSeconds',COALESCE(extract(epoch FROM clock_timestamp()-min(intent_at) FILTER(WHERE state='pending')),0),
 'expiredUnpurged',count(*) FILTER(WHERE expires_at<=clock_timestamp() AND state NOT IN ('suppressed','purged'))) FROM learning.captures
$$;

-- Suppression is synchronous with the existing authenticated deletion request. It invalidates ALL
-- active export receipts immediately; slow erasure then runs in bounded private batches.
CREATE FUNCTION learning.suppress(actor text,why text) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE epoch_now bigint; BEGIN
 IF actor IS NULL OR length(actor) NOT BETWEEN 1 AND 160 OR why IS NULL OR why NOT IN ('account-deletion','user-choice') THEN RAISE EXCEPTION 'CAPTURE_PRIVACY_ARGUMENT'; END IF;
 PERFORM 1 FROM learning.policy WHERE id FOR UPDATE;
 SELECT epoch INTO epoch_now FROM learning.suppressions WHERE actor_id=actor;
 IF FOUND THEN RETURN epoch_now; END IF;
 UPDATE learning.policy SET privacy_epoch=privacy_epoch+1 WHERE id RETURNING privacy_epoch INTO epoch_now;
 INSERT INTO learning.suppressions(actor_id,reason,epoch) VALUES(actor,why,epoch_now);
 UPDATE learning.export_runs SET state='revoked' WHERE state IN ('ready','building');
 RETURN epoch_now;
END $$;
CREATE FUNCTION learning.deletion_requested() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ BEGIN
 PERFORM learning.suppress(NEW.actor_id,'account-deletion'); RETURN NULL;
END $$;
CREATE TRIGGER learning_deletion_requested AFTER INSERT ON privacy.requests FOR EACH ROW WHEN(NEW.kind='deletion') EXECUTE FUNCTION learning.deletion_requested();
CREATE FUNCTION learning.erase(n integer DEFAULT 100) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE c record; total integer:=0; blocked boolean; BEGIN
 IF n IS NULL OR n NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'CAPTURE_ERASURE_ARGUMENT'; END IF;
 PERFORM 1 FROM learning.policy WHERE id FOR UPDATE;
 FOR c IN SELECT x.capture_id FROM learning.captures x WHERE x.state NOT IN ('purged','suppressed') AND (x.expires_at<=clock_timestamp()
  OR EXISTS(SELECT FROM learning.capture_subjects s JOIN learning.suppressions z USING(actor_id) WHERE s.capture_id=x.capture_id)) ORDER BY x.capture_id LIMIT n FOR UPDATE OF x SKIP LOCKED LOOP
  SELECT EXISTS(SELECT FROM learning.capture_subjects s JOIN learning.suppressions z USING(actor_id) WHERE s.capture_id=c.capture_id) INTO blocked;
  UPDATE learning.captures SET state=CASE WHEN blocked THEN 'suppressed' ELSE 'purged' END,source_id=c.capture_id,payload=NULL,payload_sha256=NULL,source_token=NULL,hints='{}' WHERE capture_id=c.capture_id;
  INSERT INTO learning.erasure_tombstones(capture_id) VALUES(c.capture_id) ON CONFLICT DO NOTHING;
  DELETE FROM learning.capture_subjects WHERE capture_id=c.capture_id;
  DELETE FROM learning.rejections WHERE capture_id=c.capture_id;
  UPDATE ops.outbox SET state='cancelled',payload=NULL,lease_owner=NULL,lease_until='epoch' WHERE outbox_id='learning.capture:'||c.capture_id;
  total:=total+1;
 END LOOP;
 IF total>0 THEN
  UPDATE learning.policy SET privacy_epoch=privacy_epoch+1 WHERE id;
  UPDATE learning.export_runs SET state='revoked' WHERE state IN ('ready','building');
 END IF;
 UPDATE learning.export_runs SET state='revoked' WHERE expires_at<=clock_timestamp() AND state IN ('ready','building');
 RETURN total;
END $$;
CREATE FUNCTION learning.privacy_page(after_actor text DEFAULT '',n integer DEFAULT 500) RETURNS SETOF learning.suppressions LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ SELECT * FROM learning.suppressions WHERE actor_id>after_actor ORDER BY actor_id LIMIT LEAST(GREATEST(n,1),500) $$;
CREATE FUNCTION learning.erasure_page(after_id text DEFAULT '',n integer DEFAULT 500) RETURNS TABLE(capture_id text,state text) LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ SELECT capture_id,'purged'::text FROM learning.erasure_tombstones WHERE capture_id>after_id ORDER BY capture_id LIMIT LEAST(GREATEST(n,1),500) $$;
CREATE FUNCTION learning.replay_erasure(cid text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ BEGIN
 IF cid IS NULL OR cid !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'CAPTURE_ERASURE_ARGUMENT'; END IF;
 PERFORM 1 FROM learning.policy WHERE id FOR UPDATE;
 INSERT INTO learning.erasure_tombstones(capture_id) VALUES(cid) ON CONFLICT DO NOTHING;
 UPDATE learning.captures SET state='purged',source_id=cid,payload=NULL,payload_sha256=NULL,source_token=NULL,hints='{}' WHERE capture_id=cid AND state NOT IN ('purged','suppressed');
 DELETE FROM learning.capture_subjects WHERE capture_id=cid;
 UPDATE learning.export_runs SET state='revoked' WHERE state IN ('building','ready');
END $$;
CREATE FUNCTION learning.restore_watermark(required_epoch bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ BEGIN
 IF required_epoch IS NULL OR required_epoch<0 THEN RAISE EXCEPTION 'CAPTURE_PRIVACY_EPOCH'; END IF;
 UPDATE learning.policy SET enabled=false,privacy_epoch=GREATEST(privacy_epoch,required_epoch) WHERE id;
 UPDATE learning.export_runs SET state='revoked' WHERE state IN ('building','ready');
END $$;

CREATE FUNCTION learning.begin_export(run uuid,key_name text,seed text,required_epoch bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE p learning.policy%ROWTYPE; high text; BEGIN
 SELECT * INTO p FROM learning.policy WHERE id FOR SHARE;
 IF NOT p.enabled OR required_epoch IS NULL OR required_epoch<>p.privacy_epoch THEN RAISE EXCEPTION 'CAPTURE_EXPORT_PRIVACY_FENCE'; END IF;
 SELECT max(capture_id) INTO high FROM learning.captures WHERE state='sealed' AND expires_at>clock_timestamp();
 INSERT INTO learning.export_runs(run_id,state,expires_at,privacy_epoch,policy_version,high_water,key_id,split_seed)
 VALUES(run,'building',clock_timestamp()+make_interval(days=>p.export_retention_days),p.privacy_epoch,p.policy_version,high,key_name,seed);
 RETURN jsonb_build_object('highWater',high,'privacyEpoch',p.privacy_epoch,'policyVersion',p.policy_version);
END $$;
CREATE FUNCTION learning.export_page(run uuid,after_id text DEFAULT '',n integer DEFAULT 100) RETURNS TABLE(capture_id text,payload text,payload_sha256 text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE r learning.export_runs%ROWTYPE; BEGIN
 IF n IS NULL OR n NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'CAPTURE_EXPORT_PAGE'; END IF;
 SELECT * INTO r FROM learning.export_runs WHERE run_id=run;
 IF NOT (SELECT enabled FROM learning.policy WHERE id) OR NOT FOUND OR r.state<>'building' OR r.expires_at<=clock_timestamp() OR r.privacy_epoch<>(SELECT privacy_epoch FROM learning.policy WHERE id) THEN RAISE EXCEPTION 'CAPTURE_EXPORT_REVOKED'; END IF;
 RETURN QUERY SELECT c.capture_id,c.payload,c.payload_sha256 FROM learning.captures c WHERE c.capture_id>after_id AND c.capture_id<=r.high_water
  AND c.state='sealed' AND c.sealed_at<=r.created_at AND c.expires_at>clock_timestamp()
  AND NOT EXISTS(SELECT FROM learning.capture_subjects s JOIN learning.suppressions z USING(actor_id) WHERE s.capture_id=c.capture_id)
  ORDER BY c.capture_id LIMIT n;
END $$;
CREATE FUNCTION learning.export_member(run uuid,cid text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ BEGIN
 PERFORM 1 FROM learning.policy WHERE id FOR SHARE;
 IF NOT EXISTS(SELECT FROM learning.export_runs WHERE run_id=run AND state='building' AND privacy_epoch=(SELECT privacy_epoch FROM learning.policy WHERE id)) THEN RAISE EXCEPTION 'CAPTURE_EXPORT_REVOKED'; END IF;
 IF NOT EXISTS(SELECT FROM learning.captures c JOIN learning.export_runs r ON r.run_id=run WHERE c.capture_id=cid AND c.state='sealed' AND c.expires_at>clock_timestamp() AND c.capture_id<=r.high_water AND c.sealed_at<=r.created_at) THEN RAISE EXCEPTION 'CAPTURE_EXPORT_SOURCE_INVALID'; END IF;
 INSERT INTO learning.export_members(run_id,capture_id) VALUES(run,cid) ON CONFLICT DO NOTHING;
END $$;
CREATE FUNCTION learning.finish_export(run uuid,receipt jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ BEGIN
 PERFORM 1 FROM learning.policy WHERE id FOR SHARE;
 IF receipt IS NULL OR jsonb_typeof(receipt)<>'object' OR pg_column_size(receipt)>65536 OR receipt->>'cipherSha256' IS NULL OR receipt->>'cipherSha256' !~ '^[a-f0-9]{64}$' OR (receipt->>'games')::bigint IS DISTINCT FROM (SELECT count(*) FROM learning.export_members WHERE run_id=run) THEN RAISE EXCEPTION 'CAPTURE_EXPORT_RECEIPT'; END IF;
 UPDATE learning.export_runs SET state='ready',manifest=receipt WHERE run_id=run AND state='building' AND expires_at>clock_timestamp()
  AND privacy_epoch=(SELECT privacy_epoch FROM learning.policy WHERE id AND enabled)
  AND NOT EXISTS(SELECT FROM learning.export_members m JOIN learning.captures c USING(capture_id) WHERE m.run_id=run AND (c.state<>'sealed' OR c.expires_at<=clock_timestamp()));
 IF NOT FOUND THEN RAISE EXCEPTION 'CAPTURE_EXPORT_REVOKED'; END IF;
END $$;
CREATE FUNCTION learning.export_status(run uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,learning,pg_temp AS $$
 SELECT jsonb_build_object('state',CASE WHEN r.expires_at<=clock_timestamp() OR r.privacy_epoch<>p.privacy_epoch OR NOT p.enabled THEN 'revoked' ELSE r.state END,
 'privacyEpoch',r.privacy_epoch,'manifest',r.manifest) FROM learning.export_runs r CROSS JOIN learning.policy p WHERE r.run_id=run AND p.id
$$;
CREATE FUNCTION learning.revoke_export(run uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,learning,pg_temp AS $$ UPDATE learning.export_runs SET state='revoked' WHERE run_id=run AND state<>'purged' $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA learning FROM PUBLIC;
GRANT EXECUTE ON FUNCTION learning.claim(text,integer,integer),learning.finish(text,text,bigint,text,text),learning.reject(text,text,bigint,text,boolean),learning.reconcile(text,text,integer,boolean),learning.metrics() TO capture_runtime;
GRANT EXECUTE ON FUNCTION learning.suppress(text,text),learning.erase(integer),learning.privacy_page(text,integer),learning.erasure_page(text,integer),learning.replay_erasure(text),learning.restore_watermark(bigint) TO capture_privacy;
GRANT EXECUTE ON FUNCTION learning.begin_export(uuid,text,text,bigint),learning.export_page(uuid,text,integer),learning.export_member(uuid,text),learning.finish_export(uuid,jsonb),learning.export_status(uuid),learning.revoke_export(uuid) TO capture_exporter;
