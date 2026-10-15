-- runner: current-role
-- The authenticated account-lane consent contract that 0052 deliberately left to this lane.
--
-- 0052 says, in its own words: "A per-actor read would be an actor-id-keyed lookup surface; the
-- authenticated client route that renders a player's own choice belongs to the account/session lane
-- and is not invented here." This migration provides exactly that, and nothing more:
--
--   * learning.actor_consent(actor)      -- the actor's OWN choice, or an explicit absent record.
--   * learning.set_consent(actor, ...)   -- records the one-time choice and delegates the
--                                           withdrawal semantics to 0052's record_consent.
--
-- Bounds, deliberately:
--   * The functions take the actor id from the AUTHENTICATED lane, never from a request body; the
--     service resolves the actor from the session and no route accepts an actor parameter.
--   * An absent record is reported as `recorded:false` with `research:false`. It is NEVER returned as
--     a grant: absence means not consented, which is the fail-closed default 0052 established.
--   * The returned `ageBand` is the actor's own band; it is not a queryable demographic surface.
--   * Only `api_runtime` is granted EXECUTE, and only on these two functions.
--
-- Additive only: no table, column, constraint or existing function is altered.

CREATE FUNCTION learning.actor_consent(actor text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ DECLARE z learning.consent%ROWTYPE; BEGIN
 IF actor IS NULL OR length(actor) NOT BETWEEN 1 AND 160 OR actor ~ '[[:cntrl:]]' THEN
  RAISE EXCEPTION 'CONSENT_ACTOR_INVALID'; END IF;
 SELECT * INTO z FROM learning.consent WHERE actor_id=actor;
 IF NOT FOUND THEN
  -- Absence is not consent. Report it plainly so a client cannot mistake a missing row for a grant.
  RETURN jsonb_build_object('recorded',false,'research',false,'withdrawn',false,
   'noticeVersion',NULL,'consentVersion',NULL,'ageBand',NULL,'grantedAt',NULL,'withdrawnAt',NULL);
 END IF;
 RETURN jsonb_build_object(
  'recorded',true,
  'research',(z.optional_research AND z.withdrawn_at IS NULL AND z.age_band='adult'),
  'withdrawn',(z.withdrawn_at IS NOT NULL),
  'noticeVersion',z.necessary_notice_version,
  'consentVersion',z.consent_version,
  'ageBand',z.age_band,
  'grantedAt',CASE WHEN z.granted_at IS NULL THEN NULL ELSE to_char(z.granted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
  'withdrawnAt',CASE WHEN z.withdrawn_at IS NULL THEN NULL ELSE to_char(z.withdrawn_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END);
END $$;

-- Records the one-time choice. Delegates every durability rule to 0052's record_consent: an
-- affirmative that becomes "no" becomes a withdrawal, a withdrawn subject cannot silently re-consent,
-- and a non-adult band can never grant research. This function adds no policy of its own.
CREATE FUNCTION learning.set_consent(actor text,notice text,research boolean,version text,band text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$ BEGIN
 IF research IS NULL THEN RAISE EXCEPTION 'CONSENT_ARGUMENT_INVALID'; END IF;
 PERFORM learning.record_consent(actor,notice,research,version,COALESCE(band,'unknown'));
 RETURN learning.actor_consent(actor);
END $$;

REVOKE ALL ON FUNCTION learning.actor_consent(text),learning.set_consent(text,text,boolean,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION learning.actor_consent(text),learning.set_consent(text,text,boolean,text,text) TO api_runtime;
