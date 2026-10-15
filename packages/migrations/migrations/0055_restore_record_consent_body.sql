-- runner: current-role
-- Corrects a defect in migration 0053, found by exercising the lane against a real database.
--
-- 0053 replaced learning.record_consent to make a recorded withdrawal durable, but its function body
-- was reconstructed rather than copied from 0052, and the reconstruction changed the accepted
-- `band` vocabulary from 0052's ('adult','youth','unknown') to a set of AGE BANDS. The effect was
-- worse than the bug it fixed: a legitimate call with band='adult' - the only band that can grant
-- research - was refused with CAPTURE_CONSENT_ARGUMENT, so the consent lane could not record an
-- affirmative choice at all. It survived the earlier checks because the failure was masked by
-- SCHEMA_INCOMPATIBLE for a different reason.
--
-- This migration restores 0052's record_consent EXACTLY, with only the withdrawn_at durability fix
-- applied. Verified by diffing the two bodies: the band check line is now byte-identical to 0052's.
-- A test now asserts that equality so this drift cannot recur silently.
--
-- Forward-only: 0053 is already applied in staging and production, so it is not edited.

CREATE OR REPLACE FUNCTION learning.record_consent(actor text,necessary_notice text,research boolean,version text,band text DEFAULT 'unknown')
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
   -- THE FIX (0055): only a fresh affirmative grant may clear a recorded withdrawal. A notice
   -- version bump or a declined re-record preserves it.
   withdrawn_at=CASE WHEN EXCLUDED.optional_research THEN NULL ELSE learning.consent.withdrawn_at END,
   age_band=EXCLUDED.age_band,privacy_epoch=EXCLUDED.privacy_epoch,recorded_at=EXCLUDED.recorded_at;
 EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'CAPTURE_CONSENT_CONFLICT';
 END;
 RETURN COALESCE(epoch_now,0);
END $$;
