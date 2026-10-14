-- runner: current-role
-- DC00/D1: the one-time cross-device research choice and the retention schedule as DATA.
--
-- Additive only. Nothing is enabled by this migration; every default is the fail-closed one
-- (absence of a subject consent record means NOT consented, and a payload that carries no
-- research decision is treated as operational-only by the exporter). No existing CHECK is
-- loosened, no 0044-0051 file is renumbered, and historical (pre-0052) sealed payloads keep
-- validating: the research-decision field is added as OPTIONAL by packages/learning/capture.js.
--
-- Owner decision recorded here (2026-10-14, docs/v5.2/release/DC00-CONSENT-AND-RETENTION-RECEIPT):
--   * capture purpose approved, retention schedule delegated to the operator;
--   * consented adult gameplay trajectories <= 24 months with an annual necessity review;
--   * working research exports <= 90 days and never past source expiry;
--   * raw ad analytics 90 days; pending client-upload spool 7 days;
--   * ordinary encrypted backups 35-day rolling retention, enforceable only once safe pruning
--     is validated (learning.backup_retention is a separate, explicit gate);
--   * purchases, fraud, operations and security each need their own necessary schedule;
--   * withdrawal and applicable-law limits override every maximum;
--   * youth/protected-age research needs a separate lawful protocol, not these adult defaults.
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
  IF NOT EXISTS(SELECT FROM pg_auth_members
                 WHERE roleid=r::regrole AND member='migration_owner'::regrole AND admin_option) THEN
   EXECUTE format('GRANT %I TO migration_owner WITH ADMIN OPTION',r);
  END IF;
 END LOOP;
END $$;
SET LOCAL ROLE v5_owner;

-- ------------------------------------------------------------------ 1. the research choice
-- One row per subject, written only by an authenticated choice (learning.record_consent) and
-- never by a match, a scheduler or a default. A missing row is NOT consent: optional_research has
-- no DEFAULT and the CHECK below refuses an affirmative without an explicit version, an
-- affirmative timestamp and an adult age band. Necessary operational processing is described by
-- its own notice version and does not depend on the optional choice.
CREATE TABLE learning.consent (
 actor_id text PRIMARY KEY CHECK(length(actor_id) BETWEEN 1 AND 160 AND actor_id !~ '[[:cntrl:]]'),
 necessary_notice_version text NOT NULL CHECK(length(necessary_notice_version) BETWEEN 1 AND 120),
 optional_research boolean NOT NULL,
 consent_version text NOT NULL CHECK(length(consent_version) BETWEEN 1 AND 120),
 granted_at timestamptz,
 withdrawn_at timestamptz,
 age_band text NOT NULL DEFAULT 'unknown' CHECK(age_band IN ('adult','youth','unknown')),
 privacy_epoch bigint NOT NULL DEFAULT 0 CHECK(privacy_epoch>=0),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 -- No pre-ticked default and no affirmative by convention: only a real opt-in can be stored, and
 -- it can only ever be an adult's. A row that never granted (and never withdrew a grant) carries
 -- no grant time, so an operational-only record can never be read as an unrecorded consent.
 CONSTRAINT consent_affirmative_required_ck CHECK(NOT optional_research OR (granted_at IS NOT NULL AND age_band='adult')),
 CONSTRAINT consent_unaffirmed_no_grant_ck CHECK(optional_research OR withdrawn_at IS NOT NULL OR granted_at IS NULL),
 CONSTRAINT consent_withdrawal_order_ck CHECK(withdrawn_at IS NULL OR (granted_at IS NOT NULL AND withdrawn_at>=granted_at))
);
CREATE INDEX consent_research_lookup ON learning.consent(actor_id) WHERE optional_research AND withdrawn_at IS NULL;

-- The capture purpose that was approved is research over gameplay trajectories. This decides only
-- whether a subject's records may be used for it; operational history is unaffected. The live fence
-- is the suppression row (withdrawal/erasure), never an unrelated privacy-epoch bump; the consent
-- row's privacy_epoch is recorded for audit, not used as a predicate.
--   eligible: both subjects affirmatively allow adult research, and neither is suppressed;
--   recorded: at least one subject actually made a choice (so the archive can say "declined"
--             instead of the weaker "no decision on file").
CREATE FUNCTION learning.research_decision(cid text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$
 SELECT jsonb_build_object(
  'eligible',COALESCE((SELECT bool_and(z.optional_research AND z.withdrawn_at IS NULL AND z.age_band='adult')
    FROM learning.capture_subjects s JOIN learning.consent z USING(actor_id)
    WHERE s.capture_id=cid AND NOT EXISTS(SELECT FROM learning.suppressions p WHERE p.actor_id=s.actor_id)
    HAVING count(*)=2),false),
  'recorded',EXISTS(SELECT FROM learning.capture_subjects s JOIN learning.consent z USING(actor_id) WHERE s.capture_id=cid))
$$;
CREATE FUNCTION learning.research_eligible(cid text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$
 SELECT COALESCE((learning.research_decision(cid)->>'eligible')::boolean,false)
$$;

-- Aggregate only. A per-actor read would be an actor-id-keyed lookup surface; the authenticated
-- client route that renders a player's own choice belongs to the account/session lane and is not
-- invented here.
CREATE FUNCTION learning.consent_summary() RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$
 SELECT jsonb_build_object('records',count(*),
  'researchAffirmative',count(*) FILTER(WHERE optional_research AND withdrawn_at IS NULL AND age_band='adult'),
  'operationalOnly',count(*) FILTER(WHERE NOT optional_research),
  'withdrawn',count(*) FILTER(WHERE withdrawn_at IS NOT NULL),
  'youthOrUnknown',count(*) FILTER(WHERE age_band<>'adult')) FROM learning.consent
$$;

CREATE FUNCTION learning.record_consent(actor text,necessary_notice text,research boolean,version text,band text DEFAULT 'unknown')
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE epoch_now bigint; was_affirmative boolean; BEGIN
 IF actor IS NULL OR length(actor) NOT BETWEEN 1 AND 160 OR actor ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'CAPTURE_CONSENT_ARGUMENT'; END IF;
 IF necessary_notice IS NULL OR length(necessary_notice) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'CAPTURE_CONSENT_ARGUMENT'; END IF;
 IF version IS NULL OR length(version) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'CAPTURE_CONSENT_ARGUMENT'; END IF;
 IF research IS NULL OR band IS NULL OR band NOT IN ('adult','youth','unknown') THEN RAISE EXCEPTION 'CAPTURE_CONSENT_ARGUMENT'; END IF;
 IF research AND band<>'adult' THEN RAISE EXCEPTION 'CAPTURE_CONSENT_ADULT_ONLY'; END IF;
 SELECT optional_research AND withdrawn_at IS NULL INTO was_affirmative FROM learning.consent WHERE actor_id=actor;
 -- Changing an affirmative to "no" is a withdrawal by another name: it must end the permission AND
 -- fence the records already archived under it, not merely lower a flag on the choice row.
 IF COALESCE(was_affirmative,false) AND NOT research THEN RETURN learning.withdraw_research(actor,'user-choice'); END IF;
 -- Withdrawal is durable: the suppression the erasure path relies on cannot be undone by re-ticking
 -- a box, so a withdrawn subject cannot silently re-consent the records collected before it. A
 -- genuinely returning subject is an account-lane re-engagement, not a research-consent upsert.
 IF research AND EXISTS(SELECT FROM learning.suppressions WHERE actor_id=actor) THEN
  RAISE EXCEPTION 'CAPTURE_CONSENT_WITHDRAWN'; END IF;
 SELECT privacy_epoch INTO epoch_now FROM learning.policy WHERE id;
 BEGIN
  INSERT INTO learning.consent(actor_id,necessary_notice_version,optional_research,consent_version,granted_at,withdrawn_at,age_band,privacy_epoch,recorded_at)
  VALUES(actor,necessary_notice,research,version,CASE WHEN research THEN clock_timestamp() END,NULL,band,
   COALESCE((SELECT privacy_epoch FROM learning.policy WHERE id),0),clock_timestamp())
  ON CONFLICT(actor_id) DO UPDATE SET necessary_notice_version=EXCLUDED.necessary_notice_version,
   optional_research=EXCLUDED.optional_research,consent_version=EXCLUDED.consent_version,
   granted_at=CASE WHEN EXCLUDED.optional_research THEN COALESCE(learning.consent.granted_at,EXCLUDED.granted_at) END,
   withdrawn_at=NULL,age_band=EXCLUDED.age_band,privacy_epoch=EXCLUDED.privacy_epoch,recorded_at=EXCLUDED.recorded_at;
 EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'CAPTURE_CONSENT_CONFLICT';
 END;
 RETURN COALESCE(epoch_now,0);
END $$;

-- Withdrawal is the operator-visible act that MUST dominate: it records the withdrawal on the
-- choice row AND raises the privacy epoch through learning.suppress(), which fences every open
-- export immediately, so the next erasure sweep nulls the subject's archived payloads and the
-- encrypted recovery journal carries the suppression to any restored copy.
CREATE FUNCTION learning.withdraw_research(actor text,why text DEFAULT 'user-choice') RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE epoch_now bigint; BEGIN
 IF actor IS NULL OR length(actor) NOT BETWEEN 1 AND 160 OR actor ~ '[[:cntrl:]]' OR why IS NULL
  OR why NOT IN ('user-choice','account-deletion') THEN RAISE EXCEPTION 'CAPTURE_CONSENT_ARGUMENT'; END IF;
 UPDATE learning.consent SET withdrawn_at=clock_timestamp() WHERE actor_id=actor AND withdrawn_at IS NULL;
 epoch_now:=learning.suppress(actor,why);
 -- A withdrawal must not leave an affirmative research choice behind for a restored copy to read.
 -- The original granted_at is kept as history (the withdrawal order constraint requires it); the
 -- live predicate is optional_research AND withdrawn_at IS NULL.
 UPDATE learning.consent SET optional_research=false WHERE actor_id=actor AND optional_research;
 RETURN epoch_now;
END $$;

-- Account deletion withdraws the research choice too: an erased account cannot keep a live opt-in.
CREATE OR REPLACE FUNCTION learning.deletion_requested() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ BEGIN
 PERFORM learning.withdraw_research(NEW.actor_id,'account-deletion'); RETURN NULL;
END $$;

-- ------------------------------------------------------------------ 2. the retention schedule
-- Windows, their legal/operational basis and the review/override duties live in rows, not in job
-- code, so a scheduled sweep is driven by data. Rows whose basis is not yet lawful carry NO window
-- and legal_review_required=true; the youth row can never carry an adult window.
CREATE TABLE learning.retention_schedule (
 class_id text PRIMARY KEY CHECK(class_id ~ '^[a-z][a-z0-9.-]{0,79}$'),
 data_class text NOT NULL CHECK(length(data_class) BETWEEN 1 AND 200),
 basis text NOT NULL CHECK(basis IN ('consent','necessary-operational','legal-obligation','fraud-prevention','operations','security','separate-lawful-protocol')),
 window_days integer CHECK(window_days IS NULL OR window_days BETWEEN 1 AND 3650),
 never_past_source boolean NOT NULL DEFAULT false,
 review_interval_days integer CHECK(review_interval_days IS NULL OR review_interval_days BETWEEN 1 AND 3650),
 legal_review_required boolean NOT NULL,
 approved_ref text NOT NULL CHECK(length(approved_ref) BETWEEN 1 AND 240),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT retention_window_or_review_ck CHECK(window_days IS NOT NULL OR legal_review_required),
 CONSTRAINT retention_youth_no_adult_window_ck CHECK(basis<>'separate-lawful-protocol' OR window_days IS NULL)
);
INSERT INTO learning.retention_schedule(class_id,data_class,basis,window_days,never_past_source,review_interval_days,legal_review_required,approved_ref) VALUES
 ('capture.adult-gameplay-consented','consented adult gameplay trajectories','consent',730,false,365,false,'owner-20261014-retention-schedule'),
 ('export.working-research','working research exports','consent',90,true,NULL,false,'owner-20261014-retention-schedule'),
 ('analytics.raw-ad','raw advertising analytics','necessary-operational',90,true,NULL,false,'owner-20261014-retention-schedule'),
 ('spool.pending-upload','pending client-upload spool','necessary-operational',7,true,NULL,false,'owner-20261014-retention-schedule'),
 ('backup.ordinary-encrypted','ordinary encrypted backups','necessary-operational',35,true,NULL,false,'owner-20261014-retention-schedule'),
 ('purchase.records','purchase, replay and refund integrity','legal-obligation',NULL,false,NULL,true,'owner-20261014-retention-schedule'),
 ('fraud.integrity','fraud and duplicate-grant prevention','fraud-prevention',NULL,false,NULL,true,'owner-20261014-retention-schedule'),
 ('operations.support','operations and support correlation','operations',NULL,false,NULL,true,'owner-20261014-retention-schedule'),
 ('security.audit','security and accountability audit','security',NULL,false,NULL,true,'owner-20261014-retention-schedule'),
 ('youth.research-protocol','youth/protected-age research','separate-lawful-protocol',NULL,false,NULL,true,'owner-20261014-retention-schedule');

-- A copy may never extend the life of its source: this is the single expression used by the spool
-- bound (and mirrored in packages/learning/policy.js for the offline engine).
CREATE FUNCTION learning.expiry_bound(scheduled timestamptz,source_expires timestamptz) RETURNS timestamptz LANGUAGE sql IMMUTABLE
SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN source_expires IS NULL THEN scheduled ELSE LEAST(scheduled,source_expires) END
$$;

-- The consent regime is declared by the operator at enablement, not by a convention: `consent_after`
-- is the instant from which every exported capture must be research-eligible. Until it is set, the
-- export path behaves exactly as it did before 0052 (legacy/operational data stays exportable, which
-- is what the pre-existing sealed rows need); once it is set, a later sealed capture with no
-- affirmative choice — including a declined or withdrawn one — can never leave the database.
ALTER TABLE learning.policy ADD COLUMN consent_after timestamptz;
CREATE FUNCTION learning.consent_regime_ready() RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$
 SELECT jsonb_build_object('declared',consent_after IS NOT NULL,'consentAfter',consent_after,
  'enforcedOnRealTarget',environment<>'production' OR consent_after IS NOT NULL) FROM learning.policy WHERE id
$$;

CREATE FUNCTION learning.retention_status() RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$
 SELECT jsonb_build_object(
  'schedule',(SELECT COALESCE(jsonb_agg(jsonb_build_object('classId',class_id,'dataClass',data_class,'basis',basis,
    'windowDays',window_days,'neverPastSource',never_past_source,'reviewIntervalDays',review_interval_days,
    'legalReviewRequired',legal_review_required,'approvedRef',approved_ref) ORDER BY class_id),'[]'::jsonb)
   FROM learning.retention_schedule),
  'retentionDays',p.retention_days,'exportRetentionDays',p.export_retention_days,
  'backupRetentionDays',p.backup_retention_days)
 FROM learning.policy p WHERE p.id
$$;

-- ------------------------------------------------------------------ 3. the client-upload spool
-- The 7-day spool holds a digest and a size, never the raw trajectory: the local Bot upload is
-- client-replay-validated before it becomes a source, so the unvalidated bytes stay on the client.
-- The bound is min(scheduled window, the source's own expiry).
CREATE TABLE learning.upload_spool (
 spool_id text PRIMARY KEY CHECK(length(spool_id) BETWEEN 1 AND 160 AND spool_id ~ '^[A-Za-z0-9:_-]+$'),
 actor_id text NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 160 AND actor_id !~ '[[:cntrl:]]'),
 kind text NOT NULL CHECK(kind IN ('local-bot')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','ingested','expired')),
 payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
 byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 1048576),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 ingested_capture_id text REFERENCES learning.captures(capture_id),
 CONSTRAINT spool_ingested_link_ck CHECK((state='ingested')=(ingested_capture_id IS NOT NULL))
);
CREATE INDEX spool_pending_age ON learning.upload_spool(received_at,spool_id) WHERE state IN ('pending','claimed');
CREATE FUNCTION learning.spool_retention_bound() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE days integer; src timestamptz; BEGIN
 SELECT window_days INTO days FROM learning.retention_schedule WHERE class_id='spool.pending-upload';
 IF days IS NULL THEN RAISE EXCEPTION 'CAPTURE_RETENTION_SCHEDULE_MISSING'; END IF;
 IF NEW.expires_at IS NULL THEN NEW.expires_at:=NEW.received_at+make_interval(days=>days); END IF;
 NEW.expires_at:=LEAST(NEW.expires_at,NEW.received_at+make_interval(days=>days));
 IF NEW.ingested_capture_id IS NOT NULL THEN
  SELECT expires_at INTO src FROM learning.captures WHERE capture_id=NEW.ingested_capture_id;
  NEW.expires_at:=learning.expiry_bound(NEW.expires_at,src);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER spool_retention_bound BEFORE INSERT OR UPDATE ON learning.upload_spool
FOR EACH ROW EXECUTE FUNCTION learning.spool_retention_bound();
CREATE FUNCTION learning.purge_spool(n integer DEFAULT 500) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE total integer:=0; BEGIN
 IF n IS NULL OR n NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'CAPTURE_RETENTION_ARGUMENT'; END IF;
 WITH due AS (SELECT spool_id FROM learning.upload_spool WHERE state IN ('pending','claimed')
  AND expires_at<=clock_timestamp() ORDER BY expires_at,spool_id LIMIT n FOR UPDATE SKIP LOCKED)
 DELETE FROM learning.upload_spool s USING due WHERE s.spool_id=due.spool_id;
 GET DIAGNOSTICS total=ROW_COUNT; RETURN total;
END $$;

-- ------------------------------------------------------------------ 4. backup-journal obligation
-- A withdrawn subject's records are re-suppressed on any restored copy only when the newest
-- privacy journal is replayed. Each scheduled journal publication records the epoch and cipher
-- digest it covers, so the obligation ("a journal is due before this backup is privacy-current")
-- is a recorded, checkable fact rather than an operator memory.
CREATE TABLE learning.journal_watermarks (
 watermark_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 epoch bigint NOT NULL CHECK(epoch>=0),
 cipher_sha256 text NOT NULL CHECK(cipher_sha256 ~ '^[a-f0-9]{64}$'),
 plain_sha256 text NOT NULL CHECK(plain_sha256 ~ '^[a-f0-9]{64}$'),
 records integer NOT NULL CHECK(records>=0),
 key_id text NOT NULL CHECK(length(key_id) BETWEEN 1 AND 120),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(epoch,cipher_sha256)
);
CREATE FUNCTION learning.record_journal_watermark(p_epoch bigint,p_cipher text,p_plain text,p_records integer,p_key text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE id bigint; BEGIN
 IF p_epoch IS NULL OR p_epoch<0 OR p_cipher IS NULL OR p_cipher !~ '^[a-f0-9]{64}$' OR p_plain IS NULL
  OR p_plain !~ '^[a-f0-9]{64}$' OR p_records IS NULL OR p_records<0 OR p_key IS NULL
  OR length(p_key) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'CAPTURE_JOURNAL_WATERMARK_ARGUMENT'; END IF;
 INSERT INTO learning.journal_watermarks(epoch,cipher_sha256,plain_sha256,records,key_id)
 VALUES(p_epoch,p_cipher,p_plain,p_records,p_key) ON CONFLICT(epoch,cipher_sha256) DO NOTHING;
 SELECT watermark_id INTO id FROM learning.journal_watermarks WHERE epoch=p_epoch AND cipher_sha256=p_cipher;
 RETURN id;
END $$;
CREATE FUNCTION learning.journal_obligation() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE live bigint; w learning.journal_watermarks%ROWTYPE; BEGIN
 SELECT privacy_epoch INTO live FROM learning.policy WHERE id;
 SELECT * INTO w FROM learning.journal_watermarks ORDER BY watermark_id DESC LIMIT 1;
 RETURN jsonb_build_object('liveEpoch',live,'journalEpoch',w.epoch,'cipherSha256',w.cipher_sha256,
  'records',w.records,'ageSeconds',CASE WHEN w.recorded_at IS NULL THEN NULL
   ELSE floor(extract(epoch FROM clock_timestamp()-w.recorded_at))::bigint END,
  'due',COALESCE(w.epoch,live) IS DISTINCT FROM live,'watermarks',(SELECT count(*) FROM learning.journal_watermarks));
END $$;
-- The watermark ledger is retained long enough to cover every backup it could be replayed against;
-- the newest row (and the row matching the live epoch, if any) is never pruned.
CREATE FUNCTION learning.prune_journal_watermarks(keep integer DEFAULT 20) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE total integer:=0; BEGIN
 IF keep IS NULL OR keep<2 OR keep>1000 THEN RAISE EXCEPTION 'CAPTURE_RETENTION_ARGUMENT'; END IF;
 WITH protected AS (SELECT watermark_id FROM learning.journal_watermarks ORDER BY watermark_id DESC LIMIT keep),
 due AS (SELECT w.watermark_id FROM learning.journal_watermarks w WHERE NOT EXISTS(SELECT FROM protected p WHERE p.watermark_id=w.watermark_id)
  AND w.epoch<>(SELECT privacy_epoch FROM learning.policy WHERE id))
 DELETE FROM learning.journal_watermarks j USING due WHERE j.watermark_id=due.watermark_id;
 GET DIAGNOSTICS total=ROW_COUNT; RETURN total;
END $$;

-- ------------------------------------------------------------------ 5. the backup gate
-- The owner's 35-day window applies "once safe pruning is validated". It is therefore a separate,
-- explicitly gated schedule: this row can carry the window and the operator's verification
-- reference, but nothing here enables pruning by itself, and no other object may assume it.
CREATE TABLE learning.backup_retention (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 enabled boolean NOT NULL DEFAULT false,
 window_days integer CHECK(window_days IS NULL OR window_days BETWEEN 1 AND 365),
 prune_verified_ref text CHECK(prune_verified_ref IS NULL OR length(prune_verified_ref) BETWEEN 1 AND 240),
 prune_verified_at timestamptz,
 prune_evidence_sha256 text CHECK(prune_evidence_sha256 IS NULL OR prune_evidence_sha256 ~ '^[a-f0-9]{64}$'),
 CHECK(NOT enabled OR (window_days IS NOT NULL AND prune_verified_ref IS NOT NULL
  AND prune_verified_at IS NOT NULL))
);
INSERT INTO learning.backup_retention(id) VALUES(true);
CREATE FUNCTION learning.record_backup_prune(p_days integer,p_ref text,p_evidence text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ BEGIN
 IF p_days IS NULL OR p_days NOT BETWEEN 1 AND 365 OR p_ref IS NULL OR length(p_ref) NOT BETWEEN 1 AND 240
  OR (p_evidence IS NOT NULL AND p_evidence !~ '^[a-f0-9]{64}$') THEN RAISE EXCEPTION 'CAPTURE_RETENTION_ARGUMENT'; END IF;
 IF p_days<>(SELECT window_days FROM learning.retention_schedule WHERE class_id='backup.ordinary-encrypted') THEN
  RAISE EXCEPTION 'CAPTURE_RETENTION_SCHEDULE_DRIFT'; END IF;
 UPDATE learning.backup_retention SET window_days=p_days,prune_verified_ref=p_ref,
  prune_evidence_sha256=p_evidence,prune_verified_at=clock_timestamp() WHERE id;
END $$;
CREATE FUNCTION learning.set_backup_prune_enabled(flag boolean) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ BEGIN
 IF flag IS NULL THEN RAISE EXCEPTION 'CAPTURE_RETENTION_ARGUMENT'; END IF;
 IF flag AND NOT (SELECT COALESCE(enabled OR (window_days IS NOT NULL AND prune_verified_ref IS NOT NULL AND prune_verified_at IS NOT NULL),false)
  FROM learning.backup_retention WHERE id) THEN RAISE EXCEPTION 'CAPTURE_BACKUP_PRUNE_NOT_VERIFIED'; END IF;
 UPDATE learning.backup_retention SET enabled=flag WHERE id; RETURN flag;
END $$;
CREATE FUNCTION learning.backup_prune_ready() RETURNS boolean LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$
 SELECT COALESCE(b.enabled AND b.prune_verified_at IS NOT NULL AND b.prune_verified_at<=clock_timestamp()
  AND b.window_days=(SELECT window_days FROM learning.retention_schedule WHERE class_id='backup.ordinary-encrypted'),false)
 FROM learning.backup_retention b WHERE b.id
$$;

-- ------------------------------------------------------------------ 7. export fences
-- Two fences at the export boundary, both CREATE OR REPLACE over functions the exporter already
-- calls, so no caller changes:
--   * a recorded decline (or a withdrawal, or a suppression) always dominates: a subject who said
--     no can never appear in a dataset, no matter when the capture was sealed and whether the
--     erasure sweep has already nulled the payload. This is what stops a backup or a stale export
--     from resurrecting withdrawn research;
--   * an optional-research export additionally requires the operator to declare `consent_after`,
--     the instant from which every exported capture must carry an affirmative choice. While it is
--     unset, captures with no recorded choice keep their pre-0052 export semantics, which is what
--     the already-sealed rows (and the pre-existing suites) need. `consent_regime_ready()` reports
--     the declaration so the release receipt and the scheduled sweeps can assert it.
CREATE OR REPLACE FUNCTION learning.export_fenced(cid text, cutoff timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,learning,pg_temp AS $$
 SELECT EXISTS(SELECT FROM learning.capture_subjects s JOIN learning.suppressions z USING(actor_id) WHERE s.capture_id=cid)
  OR EXISTS(SELECT FROM learning.capture_subjects s JOIN learning.consent z USING(actor_id)
    WHERE s.capture_id=cid AND (NOT z.optional_research OR z.withdrawn_at IS NOT NULL OR z.age_band<>'adult'))
  OR (cutoff IS NOT NULL AND EXISTS(SELECT FROM learning.captures c WHERE c.capture_id=cid AND c.sealed_at>=cutoff)
      AND NOT learning.research_eligible(cid))
$$;

CREATE OR REPLACE FUNCTION learning.begin_export(run uuid,key_name text,seed text,required_epoch bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE p learning.policy%ROWTYPE; high text; BEGIN
 SELECT * INTO p FROM learning.policy WHERE id FOR SHARE;
 IF NOT p.enabled OR required_epoch IS NULL OR required_epoch<>p.privacy_epoch THEN RAISE EXCEPTION 'CAPTURE_EXPORT_PRIVACY_FENCE'; END IF;
 IF seed IS NULL OR seed IS DISTINCT FROM p.split_seed THEN RAISE EXCEPTION 'CAPTURE_EXPORT_SPLIT_FROZEN'; END IF;
 SELECT max(capture_id) INTO high FROM learning.captures WHERE state='sealed' AND expires_at>clock_timestamp();
 INSERT INTO learning.export_runs(run_id,state,expires_at,privacy_epoch,policy_version,high_water,key_id,split_seed)
 VALUES(run,'building',clock_timestamp()+make_interval(days=>p.export_retention_days),p.privacy_epoch,p.policy_version,high,key_name,seed);
 RETURN jsonb_build_object('highWater',high,'privacyEpoch',p.privacy_epoch,'policyVersion',p.policy_version,
  'consentAfter',p.consent_after,'consentDeclared',p.consent_after IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION learning.begin_export(uuid,text,text,bigint) FROM PUBLIC,capture_runtime;

CREATE OR REPLACE FUNCTION learning.export_page(run uuid,after_id text DEFAULT '',n integer DEFAULT 100) RETURNS TABLE(capture_id text,payload text,payload_sha256 text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE r learning.export_runs%ROWTYPE; cutoff timestamptz; BEGIN
 IF n IS NULL OR n NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'CAPTURE_EXPORT_PAGE'; END IF;
 SELECT * INTO r FROM learning.export_runs WHERE run_id=run;
 IF NOT (SELECT enabled FROM learning.policy WHERE id) OR NOT FOUND OR r.state<>'building' OR r.expires_at<=clock_timestamp() OR r.privacy_epoch<>(SELECT privacy_epoch FROM learning.policy WHERE id) THEN RAISE EXCEPTION 'CAPTURE_EXPORT_REVOKED'; END IF;
 cutoff:=(SELECT consent_after FROM learning.policy WHERE id);
 RETURN QUERY SELECT c.capture_id,c.payload,c.payload_sha256 FROM learning.captures c WHERE c.capture_id>after_id AND c.capture_id<=r.high_water
  AND c.state='sealed' AND c.sealed_at<=r.created_at AND c.expires_at>clock_timestamp()
  AND NOT learning.export_fenced(c.capture_id,cutoff)
  ORDER BY c.capture_id LIMIT n;
END $$;
REVOKE ALL ON FUNCTION learning.export_page(uuid,text,integer) FROM PUBLIC,capture_runtime;

CREATE OR REPLACE FUNCTION learning.export_member(run uuid,cid text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ BEGIN
 PERFORM 1 FROM learning.policy WHERE id FOR SHARE;
 IF NOT EXISTS(SELECT FROM learning.export_runs WHERE run_id=run AND state='building' AND privacy_epoch=(SELECT privacy_epoch FROM learning.policy WHERE id)) THEN RAISE EXCEPTION 'CAPTURE_EXPORT_REVOKED'; END IF;
 IF learning.export_fenced(cid,(SELECT consent_after FROM learning.policy WHERE id)) THEN
  RAISE EXCEPTION 'CAPTURE_EXPORT_CONSENT_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT FROM learning.captures c JOIN learning.export_runs r ON r.run_id=run WHERE c.capture_id=cid AND c.state='sealed' AND c.expires_at>clock_timestamp() AND c.capture_id<=r.high_water AND c.sealed_at<=r.created_at) THEN RAISE EXCEPTION 'CAPTURE_EXPORT_SOURCE_INVALID'; END IF;
 INSERT INTO learning.export_members(run_id,capture_id) VALUES(run,cid) ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION learning.export_member(uuid,text) FROM PUBLIC,capture_runtime;

-- A sweep-driven close for exports that are due or past their (source-bounded) expiry. capture_privacy
-- owns it so the retention job needs no exporter credential.
CREATE FUNCTION learning.close_expired_exports(n integer DEFAULT 500) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE total integer:=0; BEGIN
 IF n IS NULL OR n NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'CAPTURE_RETENTION_ARGUMENT'; END IF;
 WITH due AS (SELECT run_id FROM learning.export_runs WHERE state IN ('ready','revoked','failed')
   AND expires_at<=clock_timestamp() ORDER BY expires_at,run_id LIMIT n FOR UPDATE SKIP LOCKED)
 UPDATE learning.export_runs r SET state='purged' FROM due WHERE r.run_id=due.run_id;
 GET DIAGNOSTICS total=ROW_COUNT; RETURN total;
END $$;

-- ------------------------------------------------------------------ 8. least-privilege grants
-- Zero table ACLs, exactly as 0044/0045: the roles reach these objects only through the functions
-- above. capture_privacy owns withdrawal, erasure, the spool sweep and the backup/journal gates.
REVOKE ALL ON ALL TABLES IN SCHEMA learning FROM PUBLIC,api_runtime,core_runtime,worker_runtime,capture_runtime,capture_exporter,capture_privacy;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA learning FROM PUBLIC;
GRANT EXECUTE ON FUNCTION learning.research_eligible(text),learning.research_decision(text),learning.consent_regime_ready(),learning.retention_status()
 TO capture_runtime,capture_exporter,capture_privacy;
GRANT EXECUTE ON FUNCTION learning.record_consent(text,text,boolean,text,text),learning.withdraw_research(text,text),
 learning.consent_summary(),learning.purge_spool(integer),learning.expiry_bound(timestamptz,timestamptz),
 learning.close_expired_exports(integer),learning.erase(integer),
 learning.record_journal_watermark(bigint,text,text,integer,text),learning.journal_obligation(),
 learning.prune_journal_watermarks(integer),learning.record_backup_prune(integer,text,text),
 learning.set_backup_prune_enabled(boolean),learning.backup_prune_ready()
 TO capture_privacy;
GRANT EXECUTE ON FUNCTION learning.begin_export(uuid,text,text,bigint),learning.export_page(uuid,text,integer),
 learning.export_member(uuid,text),learning.export_fenced(text,timestamptz) TO capture_exporter;
