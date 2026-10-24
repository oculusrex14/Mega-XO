-- runner: current-role
-- A4: cluster WAL includes provider-control writes in other databases. A backup may
-- skip only on a database-local, transactional no-change proof, never pg_stat counters.
-- The fixed 64 lanes avoid one global lock/ever-growing change journal. Each transaction
-- touches one lane; revisions become visible atomically WITH the protected data write.
CREATE TABLE ops.backup_change_clock (
  lane smallint PRIMARY KEY CHECK (lane BETWEEN 0 AND 63),
  epoch text NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
ALTER TABLE ops.backup_change_clock OWNER TO v5_owner;
WITH seed AS MATERIALIZED (SELECT md5(random()::text || clock_timestamp()::text) AS epoch)
INSERT INTO ops.backup_change_clock(lane, epoch)
SELECT lane, seed.epoch FROM generate_series(0,63) lane CROSS JOIN seed;
REVOKE ALL ON ops.backup_change_clock FROM PUBLIC, api_runtime, core_runtime, worker_runtime, audit_runtime;
GRANT SELECT ON ops.backup_change_clock TO backup_reader;
-- The historical learning sequence lacked the read permission required for an
-- exact (including never-called) sequence snapshot. This is read-only backup access.
GRANT SELECT ON SEQUENCE learning.journal_watermarks_watermark_id_seq TO backup_reader;

CREATE FUNCTION ops.backup_mark_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE ops.backup_change_clock SET revision = revision + 1
  WHERE lane = mod(pg_current_xact_id()::text::numeric,64)::smallint;
  IF NOT FOUND THEN RAISE EXCEPTION 'BACKUP_CHANGE_CLOCK_INCOMPLETE'; END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION ops.backup_mark_change() OWNER TO v5_owner;
REVOKE ALL ON FUNCTION ops.backup_mark_change() FROM PUBLIC;

-- Management-only enrollment. Recheck coverage at EVERY probe; disabling/removing
-- a guard never authorizes a skip. Always guards also run in replica sessions.
CREATE FUNCTION ops.backup_enroll_tables() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.oid,n.nspname,c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND c.relpersistence='p'
      AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
      AND c.oid<>'ops.backup_change_clock'::regclass
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=t.oid AND tgname='backup_change_row') THEN
      EXECUTE format('CREATE TRIGGER backup_change_row AFTER INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION ops.backup_mark_change()',t.nspname,t.relname);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=t.oid AND tgname='backup_change_truncate') THEN
      EXECUTE format('CREATE TRIGGER backup_change_truncate AFTER TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION ops.backup_mark_change()',t.nspname,t.relname);
    END IF;
    EXECUTE format('ALTER TABLE %I.%I ENABLE ALWAYS TRIGGER backup_change_row',t.nspname,t.relname);
    EXECUTE format('ALTER TABLE %I.%I ENABLE ALWAYS TRIGGER backup_change_truncate',t.nspname,t.relname);
  END LOOP;
END $$;
-- Keep this function owned by the privileged migration identity: historical objects
-- include provider-owned learning/ledger tables, while no runtime can execute it.
REVOKE ALL ON FUNCTION ops.backup_enroll_tables() FROM PUBLIC;
SELECT ops.backup_enroll_tables();

CREATE FUNCTION ops.backup_mark_ddl() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE ops.backup_change_clock SET revision=revision+1
    WHERE lane=mod(pg_current_xact_id()::text::numeric,64)::smallint;
  IF NOT FOUND THEN RAISE EXCEPTION 'BACKUP_CHANGE_CLOCK_INCOMPLETE'; END IF;
  -- Enrollment issues DDL itself. Recursive events still mark the change but do
  -- not recursively enroll. This GUC is only an optimization for trusted DDL;
  -- a missing guard is independently rejected by the read-only probe.
  IF current_setting('mega.backup_enrolling',true) IS DISTINCT FROM 'on'
     AND TG_TAG IN ('CREATE TABLE','CREATE TABLE AS','SELECT INTO','ALTER TABLE') THEN
    PERFORM set_config('mega.backup_enrolling','on',true);
    PERFORM ops.backup_enroll_tables();
    PERFORM set_config('mega.backup_enrolling','off',true);
  END IF;
END $$;
REVOKE ALL ON FUNCTION ops.backup_mark_ddl() FROM PUBLIC;
CREATE EVENT TRIGGER mega_backup_ddl ON ddl_command_end EXECUTE FUNCTION ops.backup_mark_ddl();
ALTER EVENT TRIGGER mega_backup_ddl ENABLE ALWAYS;
CREATE EVENT TRIGGER mega_backup_drop ON sql_drop EXECUTE FUNCTION ops.backup_mark_ddl();
ALTER EVENT TRIGGER mega_backup_drop ENABLE ALWAYS;

-- STABLE keeps catalog/clock reads on the statement's MVCC snapshot. Sequence
-- last_value AND is_called are read directly (pg_sequences hides an uncalled value).
-- nextval/setval need no xid and therefore require their own exact token component.
CREATE FUNCTION ops.backup_change_probe() RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE covered boolean; seq record; value bigint; called boolean;
  sequence_state jsonb := '[]'::jsonb; revisions jsonb; epoch_value text;
BEGIN
  SELECT count(*)=64 AND min(epoch)=max(epoch),jsonb_agg(revision::text ORDER BY lane),min(epoch)
    INTO covered,revisions,epoch_value FROM ops.backup_change_clock;
  covered := covered AND NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
      AND c.oid<>'ops.backup_change_clock'::regclass
      AND ((c.relkind IN ('r','p','m') AND c.relpersistence='u') OR
        (c.relkind IN ('r','p') AND (NOT EXISTS (
          SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid AND tgname='backup_change_row'
            AND tgfoid='ops.backup_mark_change()'::regprocedure AND tgenabled='A' AND tgtype=29
        ) OR NOT EXISTS (
          SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid AND tgname='backup_change_truncate'
            AND tgfoid='ops.backup_mark_change()'::regprocedure AND tgenabled='A' AND tgtype=32
        ))))
  ) AND (SELECT count(*)=2 FROM pg_event_trigger
      WHERE evtname IN ('mega_backup_ddl','mega_backup_drop') AND evtenabled='A'
        AND evtfoid='ops.backup_mark_ddl()'::regprocedure)
    AND NOT EXISTS (SELECT 1 FROM pg_largeobject_metadata);
  FOR seq IN SELECT c.oid,n.nspname,c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S'
      AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
      ORDER BY n.nspname,c.relname
  LOOP
    EXECUTE format('SELECT last_value,is_called FROM %I.%I',seq.nspname,seq.relname) INTO value,called;
    sequence_state := sequence_state || jsonb_build_array(jsonb_build_array(seq.nspname,seq.relname,value::text,called));
  END LOOP;
  RETURN jsonb_build_object('format','mega-v5-db-change/v1','database',current_database(),
    'epoch',epoch_value,'covered',covered,'revisions',revisions,'sequences',sequence_state);
END $$;
ALTER FUNCTION ops.backup_change_probe() OWNER TO v5_owner;
REVOKE ALL ON FUNCTION ops.backup_change_probe() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.backup_change_probe() TO backup_reader;
