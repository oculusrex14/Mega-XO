-- runner: current-role
-- Forward-only corrections to two defects in 0052, found by independent review and reproduced.
-- 0052 is already applied in staging and production, so it is NOT edited: editing an applied migration
-- would change its checksum and rewrite the ledger. These are CREATE OR REPLACE + a comment-safe
-- function body change only; no table, column, constraint or grant is altered, and no row is touched.
--
-- Defect 1 — learning.record_consent cleared `withdrawn_at`.
--   The ON CONFLICT DO UPDATE set `withdrawn_at=NULL` unconditionally. A later record that is NOT a
--   fresh affirmative research grant - a notice-version bump, or re-recording the choice with research
--   declined - therefore erased the row-level withdrawal record and consent_summary()'s withdrawn
--   count, leaving the subject's row reading as never-withdrawn. Clearing is now reserved for a
--   genuine new grant, which the pre-existing suppression guard only permits for a non-withdrawn
--   subject anyway. A non-affirmative re-record can no longer clear a recorded withdrawal.
--
-- Defect 2 — learning.close_expired_exports never retired runs stuck in 'building'.
--   An exporter that died mid-run left a row in state 'building' that the sweep's state filter never
--   selected, so the documented source-bounded export retention silently did not apply to it and the
--   run row plus its export_members accumulated. 'building' is now included. It leaks nothing:
--   export_page already raises CAPTURE_EXPORT_REVOKED for any run past expires_at.
--
-- Rollback: re-running 0052's definitions restores the previous behaviour. Both changes only tighten
-- what the functions do; neither can create or expose data.

-- ---------------------------------------------------------------- 1. durable withdrawal
-- The body below is 0052's record_consent verbatim except for the withdrawn_at expression, which is
-- the only behavioural difference and is called out in the comment at that line.
CREATE OR REPLACE FUNCTION learning.record_consent(actor text,necessary_notice text,research boolean,version text,band text DEFAULT 'unknown')
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE epoch_now bigint; was_affirmative boolean; BEGIN
 IF actor IS NULL OR length(actor) NOT BETWEEN 1 AND 160 OR actor ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'CAPTURE_CONSENT_ARGUMENT'; END IF;
 IF necessary_notice IS NULL OR length(necessary_notice) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'CAPTURE_CONSENT_ARGUMENT'; END IF;
 IF version IS NULL OR length(version) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'CAPTURE_CONSENT_ARGUMENT'; END IF;
 IF band IS NOT NULL AND band NOT IN ('unknown','under-13','13-15','16-17','18-24','25-34','35-44','45-54','55-64','65-plus','prefer-not-to-say') THEN RAISE EXCEPTION 'CAPTURE_CONSENT_ARGUMENT'; END IF;
 SELECT optional_research INTO was_affirmative FROM learning.consent WHERE actor_id=actor;
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
   -- THE FIX: only a fresh affirmative grant may clear a recorded withdrawal. A notice-version bump
   -- or a declined re-record preserves it.
   withdrawn_at=CASE WHEN EXCLUDED.optional_research THEN NULL ELSE learning.consent.withdrawn_at END,
   age_band=EXCLUDED.age_band,privacy_epoch=EXCLUDED.privacy_epoch,recorded_at=EXCLUDED.recorded_at;
 EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'CAPTURE_CONSENT_CONFLICT';
 END;
 RETURN COALESCE(epoch_now,0);
END $$;

-- ------------------------------------------------- 2. exports stuck in 'building' are swept
CREATE OR REPLACE FUNCTION learning.close_expired_exports(n integer DEFAULT 500) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE total integer:=0; BEGIN
 IF n IS NULL OR n NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'CAPTURE_RETENTION_ARGUMENT'; END IF;
 -- 'building' is included: an exporter that died mid-run would otherwise never be selected, so the
 -- documented source-bounded export retention would silently not apply to it. Past expires_at the run
 -- is already fenced and unreachable via export_page, so retiring the row leaks nothing.
 WITH due AS (SELECT run_id FROM learning.export_runs WHERE state IN ('ready','revoked','failed','building')
   AND expires_at<=clock_timestamp() ORDER BY expires_at,run_id LIMIT n FOR UPDATE SKIP LOCKED)
 UPDATE learning.export_runs r SET state='purged' FROM due WHERE r.run_id=due.run_id;
 GET DIAGNOSTICS total=ROW_COUNT; RETURN total;
END $$;

-- Grants are unchanged from 0052: these are replacements of functions the same roles already hold.
