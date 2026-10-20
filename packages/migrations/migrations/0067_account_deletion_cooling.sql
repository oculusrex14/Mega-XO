-- B4 / SAGAN-004 / F054. Expand only; never grant API outbox UPDATE or worker economy DML.
ALTER TABLE privacy.requests ADD COLUMN execute_at timestamptz;
ALTER TABLE privacy.requests ADD COLUMN core_erased_at timestamptz;
ALTER TABLE privacy.requests DROP CONSTRAINT requests_state_check;
ALTER TABLE privacy.requests ADD CONSTRAINT requests_state_check CHECK
  (state IN ('requested','cooling','verified','processing','completed','cancelled','failed'));
ALTER TABLE privacy.requests ADD CONSTRAINT requests_cooling_deadline_ck CHECK
  (state <> 'cooling' OR (execute_at IS NOT NULL AND execute_at >= requested_at + interval '30 days'));
CREATE UNIQUE INDEX requests_one_cooling_actor_idx ON privacy.requests(actor_id) WHERE state = 'cooling';
ALTER TABLE privacy.deletion_receipts ADD COLUMN note TEXT NOT NULL DEFAULT '';
-- Legacy pending jobs already disabled credentials at intake. Drain those too; never let mail's
-- generic expiry sweep discard their remaining erasure obligation on day 30.
UPDATE ops.outbox SET expires_at='9999-12-31T00:00:00Z'
  WHERE kind='account.deletion' AND state IN ('queued','sending');

-- Cancellation is one actor/request-specific capability. The caller holds the shared auth mutex
-- and eligibility row; the request lock serializes with the executor. A terminal outbox seals its body.
CREATE FUNCTION privacy.cancel_account_deletion(p_actor text, p_request text, p_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r privacy.requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM privacy.requests WHERE request_id=p_request AND actor_id=p_actor FOR UPDATE;
  IF NOT FOUND OR r.state='cancelled' THEN RAISE EXCEPTION 'DELETION_NOT_PENDING'; END IF;
  IF r.state <> 'cooling' OR r.execute_at <= p_at THEN RAISE EXCEPTION 'DELETION_CANCELLATION_CLOSED'; END IF;
  UPDATE privacy.requests SET state='cancelled', updated_at=p_at, note='cancelled in app' WHERE request_id=p_request;
  UPDATE ops.outbox SET state='cancelled', payload=NULL, lease_owner=NULL,
    lease_until='1970-01-01T00:00:00Z', lease_token=COALESCE(lease_token,0)+1
    WHERE kind='account.deletion' AND outbox_id='account.deletion:' || p_request AND state IN ('queued','sending');
END $$;

-- Read-only admission guard shared by Core paths. Existing account_activity also hides cooling
-- actors from social reads. No verified/suspended/security_hold bit changes during cooling.
CREATE FUNCTION privacy.account_deletion_pending(p_actor text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM privacy.requests WHERE actor_id=p_actor AND kind='deletion'
    AND state NOT IN ('cancelled','completed'));
$$;

-- A Core-owned, request-scoped erasure capability; worker_runtime cannot execute it. Do not delete
-- the actor: purchase/store bindings and security/moderation records must survive without cascades.
-- Immutable ledger/payout history and shared match/tournament aggregates require operator follow-up.
CREATE FUNCTION privacy.erase_account_core_state(p_request text, p_actor text, p_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r privacy.requests%ROWTYPE;
BEGIN
  PERFORM 1 FROM identity.eligibility WHERE actor_id=p_actor FOR UPDATE;
  SELECT * INTO r FROM privacy.requests WHERE request_id=p_request AND actor_id=p_actor FOR UPDATE;
  IF NOT FOUND OR r.state <> 'processing' OR COALESCE(r.execute_at,r.requested_at)>p_at THEN
    RAISE EXCEPTION 'DELETION_NOT_DUE'; END IF;
  IF r.core_erased_at IS NOT NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM core.actor_occupancy WHERE actor_id=p_actor)
     OR EXISTS (SELECT 1 FROM match.participants p JOIN match.matches m USING(match_id)
       WHERE p.actor_id=p_actor AND m.status IN ('OFFERED','PLAYING'))
     OR EXISTS (SELECT 1 FROM economy.wallets WHERE actor_id=p_actor AND (reserved_coins<>0 OR reserved_crowns<>0)) THEN
    RAISE EXCEPTION 'ACCOUNT_BUSY'; END IF;
  DELETE FROM economy.daily_progress WHERE actor_id=p_actor;
  DELETE FROM economy.wallet_operations WHERE actor_id=p_actor;
  DELETE FROM economy.wallet_ledger_entries WHERE actor_id=p_actor;
  DELETE FROM economy.command_outcomes WHERE actor_id=p_actor;
  DELETE FROM economy.match_history WHERE actor_id=p_actor;
  DELETE FROM economy.season_history WHERE actor_id=p_actor;
  DELETE FROM economy.season_state WHERE actor_id=p_actor;
  DELETE FROM economy.tournament_records WHERE actor_id=p_actor;
  DELETE FROM economy.ratings WHERE actor_id=p_actor;
  DELETE FROM economy.wallets WHERE actor_id=p_actor;
  DELETE FROM economy.actor_legacy_extra WHERE actor_id=p_actor;
  DELETE FROM cosmetics.owned_items WHERE actor_id=p_actor;
  DELETE FROM season.day_snapshots WHERE actor_id=p_actor;
  DELETE FROM monetization.ad_ticket_context WHERE ticket_id IN
    (SELECT ticket_id FROM monetization.reward_tickets WHERE actor_id=p_actor);
  DELETE FROM monetization.reward_tickets WHERE actor_id=p_actor;
  DELETE FROM monetization.credits WHERE actor_id=p_actor;
  DELETE FROM monetization.redeemed_frames WHERE actor_id=p_actor;
  DELETE FROM monetization.boosts WHERE actor_id=p_actor;
  DELETE FROM monetization.reward_daily WHERE actor_id=p_actor;
  DELETE FROM monetization.casual_rewards WHERE actor_id=p_actor;
  DELETE FROM monetization.reward_events WHERE actor_id=p_actor;
  UPDATE privacy.requests SET core_erased_at=p_at, updated_at=p_at WHERE request_id=p_request;
END $$;

-- Worker finalization is atomic with the fenced outbox completion and permanent receipt. Its
-- only privileged effects are account/social cleanup; no competitive/economic table is written.
-- The JS caller first takes the SAME actor auth mutex as sign-in/intake/cancellation.
CREATE FUNCTION privacy.finish_account_deletion(p_request text, p_actor text, p_job text,
  p_owner text, p_fence bigint, p_at timestamptz, p_tombstone text, p_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r privacy.requests%ROWTYPE; n text;
BEGIN
  PERFORM 1 FROM identity.eligibility WHERE actor_id=p_actor FOR UPDATE;
  SELECT * INTO r FROM privacy.requests WHERE request_id=p_request AND actor_id=p_actor FOR UPDATE;
  IF NOT FOUND OR r.state<>'processing' OR r.core_erased_at IS NULL
    OR COALESCE(r.execute_at,r.requested_at)>p_at THEN RAISE EXCEPTION 'DELETION_NOT_DUE'; END IF;
  PERFORM 1 FROM ops.outbox WHERE outbox_id=p_job AND kind='account.deletion' AND state='sending'
    AND lease_owner=p_owner AND lease_token=p_fence AND lease_until>p_at FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'STALE_LEASE'; END IF;
  IF p_tombstone !~ '^deleted_[0-9a-f]{32}$' OR p_hash !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'INVALID_DELETION_PAYLOAD'; END IF;
  DELETE FROM identity.signin_attempts WHERE target_actor=p_actor OR session_hash IN
    (SELECT token_hash FROM identity.sessions WHERE actor_id=p_actor);
  DELETE FROM identity.sessions WHERE actor_id=p_actor;
  DELETE FROM identity.refresh_families WHERE actor_id=p_actor;
  DELETE FROM identity.realtime_tickets WHERE actor_id=p_actor;
  DELETE FROM identity.devices WHERE actor_id=p_actor;
  DELETE FROM identity.email_challenges WHERE actor_id=p_actor OR email IN
    (SELECT email FROM identity.email_credentials WHERE actor_id=p_actor);
  DELETE FROM identity.identities WHERE actor_id=p_actor;
  DELETE FROM identity.email_credentials WHERE actor_id=p_actor;
  UPDATE identity.eligibility SET verified=false WHERE actor_id=p_actor;
  UPDATE identity.profiles SET username=left(p_tombstone,24), display_name=left(p_tombstone,24),
    avatar='board', stats_visibility='private', presence_visibility='hidden', version=version+1 WHERE actor_id=p_actor;
  DELETE FROM profile.profile_saves WHERE actor_id=p_actor;
  DELETE FROM social.friendships WHERE actor_a=p_actor OR actor_b=p_actor;
  DELETE FROM social.friend_requests WHERE from_id=p_actor OR to_id=p_actor;
  DELETE FROM social.blocks WHERE blocker_id=p_actor OR blocked_id=p_actor;
  DELETE FROM social.command_outcomes WHERE actor_id=p_actor;
  DELETE FROM privacy.reports WHERE reporter_id=p_actor AND state='open';
  UPDATE privacy.reports SET reporter_id=p_tombstone, detail='' WHERE reporter_id=p_actor;
  UPDATE privacy.reports SET target_id=p_tombstone, detail='' WHERE target_id=p_actor;
  n := 'operator-follow-up: immutable economy ledger and weekly payouts; shared match/tournament history and command outcomes; learning captures/consent; provider subscriptions and promotion/monetization replay history. These are not certified erased.';
  INSERT INTO privacy.deletion_receipts(receipt_id,actor_hash,tombstone,completed_at,policy_version,retained,note)
    VALUES(p_request,p_hash,p_tombstone,p_at,r.policy_version,
      '["purchase_replay_records","operator_security_audit","pseudonymized_moderation_outcomes"]'::jsonb,n);
  UPDATE privacy.requests SET state='completed', actor_id=p_tombstone, updated_at=p_at, completed_at=p_at, note=n WHERE request_id=p_request;
  UPDATE ops.outbox SET state='sent',payload=NULL,lease_owner=NULL,lease_until='1970-01-01T00:00:00Z'
    WHERE outbox_id=p_job;
END $$;

-- Fence tournament and match admission too, including commands racing an already-issued ticket.
CREATE FUNCTION privacy.guard_deletion_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
  PERFORM 1 FROM identity.eligibility WHERE actor_id=NEW.actor_id FOR UPDATE;
  IF privacy.account_deletion_pending(NEW.actor_id) THEN RAISE EXCEPTION 'ACCOUNT_DELETION_PENDING'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER actor_occupancy_deletion_guard BEFORE INSERT OR UPDATE ON core.actor_occupancy
  FOR EACH ROW EXECUTE FUNCTION privacy.guard_deletion_admission();

REVOKE ALL ON FUNCTION privacy.cancel_account_deletion(text,text,timestamptz),
 privacy.account_deletion_pending(text), privacy.erase_account_core_state(text,text,timestamptz),
 privacy.finish_account_deletion(text,text,text,text,bigint,timestamptz,text,text),
 privacy.guard_deletion_admission() FROM PUBLIC;
GRANT USAGE ON SCHEMA privacy TO core_runtime;
GRANT EXECUTE ON FUNCTION privacy.cancel_account_deletion(text,text,timestamptz) TO api_runtime;
GRANT EXECUTE ON FUNCTION privacy.account_deletion_pending(text) TO core_runtime;
GRANT EXECUTE ON FUNCTION privacy.erase_account_core_state(text,text,timestamptz) TO core_runtime;
GRANT EXECUTE ON FUNCTION privacy.finish_account_deletion(text,text,text,text,bigint,timestamptz,text,text) TO worker_runtime;
