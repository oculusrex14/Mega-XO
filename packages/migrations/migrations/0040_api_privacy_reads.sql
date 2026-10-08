-- V5 P04 - complete approved privacy export without API economy/Core table grants.
-- The lightweight activity projection is also the authoritative API visibility/deletion
-- check after locking eligibility. Runtime constructors never create these functions.

CREATE FUNCTION profile.account_activity(p_actor text)
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT json_build_object(
    'deletionPending', EXISTS (
      SELECT 1 FROM privacy.requests r WHERE r.actor_id = p_actor AND r.kind = 'deletion'
        AND r.state NOT IN ('cancelled', 'completed')
    ),
    'competitiveBusy', EXISTS (SELECT 1 FROM core.actor_occupancy o WHERE o.actor_id = p_actor)
      OR EXISTS (
        SELECT 1 FROM match.participants p JOIN match.matches m ON m.match_id = p.match_id
        WHERE p.actor_id = p_actor AND m.status IN ('OFFERED', 'PLAYING')
      )
  );
$function$;

CREATE FUNCTION profile.account_export(p_actor text)
RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  actor_state json;
  days json;
  journal json;
  receipts json;
  redeemed json;
  boosts json;
  reward_days json;
  credits json;
BEGIN
  actor_state := profile.account_state(p_actor);
  IF actor_state IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(json_object_agg(rows.day, rows.value ORDER BY rows.day), '{}'::json)
    INTO days FROM (
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day, json_build_object(
        'finished', d.finished, 'seconds', d.seconds, 'boards', d.boards,
        'casual', d.casual, 'friend', d.friend, 'ranked', d.ranked,
        'rankedBonus', d.ranked_bonus, 'claimed', d.claimed
      ) AS value FROM economy.daily_progress d
      WHERE d.actor_id = p_actor ORDER BY d.day LIMIT 20000
    ) rows;

  SELECT COALESCE(json_agg(rows.value ORDER BY rows.at, rows.entry_id), '[]'::json)
    INTO journal FROM (
      SELECT e.at, e.entry_id, json_build_object(
        'id', e.entry_id, 'actor', e.actor_id, 'currency', e.currency, 'amount', e.amount,
        'reason', e.reason, 'source', e.source, 'at', (extract(epoch FROM e.at) * 1000)::bigint
      ) AS value FROM economy.ledger e
      WHERE e.actor_id = p_actor ORDER BY e.at, e.entry_id LIMIT 20000
    ) rows;

  SELECT COALESCE(json_agg(rows.value ORDER BY rows.store, rows.transaction_id), '[]'::json)
    INTO receipts FROM (
      SELECT r.store, r.transaction_id, json_build_object(
        'transactionId', r.store || ':' || r.transaction_id, 'actor', r.actor_id,
        'productId', r.product_id, 'crowns', r.crowns, 'refunded', r.refunded,
        'at', (extract(epoch FROM r.purchased_at) * 1000)::bigint
      ) AS value FROM monetization.receipts r
      WHERE r.actor_id = p_actor ORDER BY r.store, r.transaction_id LIMIT 20000
    ) rows;

  SELECT COALESCE(json_agg(rows.frame ORDER BY rows.frame), '[]'::json)
    INTO redeemed FROM (
      SELECT r.frame FROM monetization.redeemed_frames r
      WHERE r.actor_id = p_actor ORDER BY r.frame LIMIT 20000
    ) rows;

  SELECT COALESCE(json_agg(rows.value ORDER BY rows.boost_seq), '[]'::json)
    INTO boosts FROM (
      SELECT b.boost_seq, json_build_object(
        'startedAt', (extract(epoch FROM b.started_at) * 1000)::bigint,
        'endsAt', (extract(epoch FROM b.ends_at) * 1000)::bigint
      ) AS value FROM monetization.boosts b
      WHERE b.actor_id = p_actor ORDER BY b.boost_seq LIMIT 20000
    ) rows;

  SELECT COALESCE(json_object_agg(rows.day, rows.value ORDER BY rows.day), '{}'::json)
    INTO reward_days FROM (
      SELECT to_char(r.day, 'YYYY-MM-DD') AS day, json_build_object(
        'base', r.base, 'bonus', r.bonus, 'automatic', r.automatic
      ) AS value FROM monetization.reward_daily r
      WHERE r.actor_id = p_actor ORDER BY r.day LIMIT 20000
    ) rows;

  SELECT json_build_object(
    'credits', c.credit_balance, 'equipped', c.equipped_frame,
    'lastAdAt', (extract(epoch FROM c.last_ad_at) * 1000)::bigint,
    'lastRewardStart', (extract(epoch FROM c.last_reward_start) * 1000)::bigint
  ) INTO credits FROM monetization.credits c WHERE c.actor_id = p_actor;

  -- No silently partial export. These are the existing repository's bounded children reads.
  IF json_array_length(journal) >= 20000 OR json_array_length(receipts) >= 20000
     OR json_array_length(redeemed) >= 20000 OR json_array_length(boosts) >= 20000
     OR (SELECT count(*) FROM json_object_keys(days)) >= 20000
     OR (SELECT count(*) FROM json_object_keys(reward_days)) >= 20000 THEN
    RAISE EXCEPTION 'STATE_TRUNCATED' USING ERRCODE = '54000';
  END IF;

  RETURN json_build_object(
    'state', actor_state, 'daily', days, 'economyJournal', journal, 'purchaseReceipts', receipts,
    'monetization', json_build_object(
      'credits', credits->'credits', 'equipped', credits->'equipped',
      'redeemed', redeemed, 'boosts', boosts, 'daily', reward_days,
      'lastAdAt', credits->'lastAdAt', 'lastRewardStart', credits->'lastRewardStart'
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION profile.account_activity(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION profile.account_export(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION profile.account_activity(text), profile.account_export(text) TO api_runtime;
