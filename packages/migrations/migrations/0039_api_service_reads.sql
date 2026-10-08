-- V5 P04 - API reads secrets only for its authentication state machines and receives a
-- narrow, read-only competitive/economic projection. No API economy/core table grants.
-- Functions are owned by v5_owner through the normal migration runner; runtime code
-- cannot create/replace them. Every relation is qualified and PUBLIC execution is revoked.

CREATE FUNCTION identity.auth_credential(p_email text, p_actor text)
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, identity
AS $function$
  SELECT json_build_object(
    'email', c.email, 'actorId', c.actor_id, 'salt', c.salt,
    'passwordHash', c.password_hash,
    'createdAt', (extract(epoch FROM c.created_at) * 1000)::bigint,
    'verifiedAt', (extract(epoch FROM c.verified_at) * 1000)::bigint
  )
  FROM identity.email_credentials c
  WHERE (p_email IS NOT NULL AND lower(c.email) = lower(p_email)
         AND (p_actor IS NULL OR c.actor_id = p_actor))
     OR (p_email IS NULL AND c.actor_id = p_actor)
  LIMIT 1;
$function$;

CREATE FUNCTION identity.auth_challenge(p_id text, p_session_hash text)
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, identity
AS $function$
  SELECT json_build_object(
    'challengeId', c.challenge_id, 'sessionHash', c.session_hash,
    'email', c.email, 'purpose', c.purpose, 'actorId', c.actor_id,
    'codeHash', c.code_hash, 'passwordSalt', c.password_salt,
    'passwordHash', c.password_hash, 'credentialHash', v.credential_hash,
    'createdAt', (extract(epoch FROM c.created_at) * 1000)::bigint,
    'expiresAt', (extract(epoch FROM c.expires_at) * 1000)::bigint,
    'attempts', c.attempts,
    'verifiedAt', (extract(epoch FROM c.verified_at) * 1000)::bigint,
    'consumed', c.consumed
  )
  FROM identity.email_challenges c
  LEFT JOIN identity.email_credential_versions v ON v.challenge_id = c.challenge_id
  WHERE c.challenge_id = p_id AND c.session_hash = p_session_hash
  LIMIT 1;
$function$;

CREATE FUNCTION identity.auth_signin_attempt(p_state_hash text)
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, identity
AS $function$
  SELECT json_build_object(
    'stateHash', s.state_hash, 'sessionHash', s.session_hash,
    'provider', s.provider, 'kind', s.kind, 'intent', s.intent,
    'targetActor', s.target_actor, 'nonce', s.nonce, 'verifier', s.verifier,
    'expiresAt', (extract(epoch FROM s.expires_at) * 1000)::bigint,
    'used', s.used
  )
  FROM identity.signin_attempts s
  WHERE s.state_hash = p_state_hash
  LIMIT 1;
$function$;

CREATE FUNCTION profile.account_state(p_actor text)
RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  result json;
BEGIN
  SELECT json_build_object(
    'walletReady', w.actor_id IS NOT NULL,
    'wealth', json_build_object(
      'coins', w.coins, 'crowns', w.crowns,
      'reservedCoins', w.reserved_coins, 'reservedCrowns', w.reserved_crowns,
      'purchaseInfluenced', w.purchase_influenced,
      'owned', COALESCE((
        SELECT json_agg(items.item ORDER BY items.item)
        FROM (SELECT ci.item FROM cosmetics.owned_items ci
              WHERE ci.actor_id = a.actor_id ORDER BY ci.item LIMIT 20000) items
      ), '[]'::json),
      'monetization', json_build_object('credits', c.credit_balance, 'equipped', c.equipped_frame)
    ),
    'competitive', json_build_object(
      'rating', r.rating, 'peak', r.peak, 'games', r.games,
      'casualRating', r.casual_rating, 'casualGames', r.casual_games, 'tier', r.tier,
      'reachedAt', (extract(epoch FROM r.reached_at) * 1000)::bigint,
      'lastRatedAt', (extract(epoch FROM r.last_rated_at) * 1000)::bigint,
      'activeMatch', CASE WHEN o.kind = 'tournament' THEN 'tournament:' || o.ref_id ELSE o.ref_id END
    ),
    'season', CASE WHEN s.actor_id IS NULL THEN NULL ELSE json_build_object(
      'id', s.season_id, 'startedAt', (extract(epoch FROM s.started_at) * 1000)::bigint,
      'games', s.games, 'queueGames', s.queue_games, 'opponents', s.opponents,
      'wins', s.wins, 'losses', s.losses, 'draws', s.draws, 'peakRating', s.peak_rating,
      'lastRatedAt', (extract(epoch FROM s.last_rated_at) * 1000)::bigint,
      'qualifiedAt', (extract(epoch FROM s.qualified_at) * 1000)::bigint
    ) END,
    'seasonHistory', COALESCE((
      SELECT json_agg(entries.value ORDER BY entries.seq) FROM (
        SELECT sh.seq, json_build_object(
          'id', sh.season_id, 'startedAt', (extract(epoch FROM sh.started_at) * 1000)::bigint,
          'games', sh.games, 'queueGames', sh.queue_games, 'opponents', sh.opponents,
          'wins', sh.wins, 'losses', sh.losses, 'draws', sh.draws, 'peakRating', sh.peak_rating,
          'lastRatedAt', (extract(epoch FROM sh.last_rated_at) * 1000)::bigint,
          'qualifiedAt', (extract(epoch FROM sh.qualified_at) * 1000)::bigint,
          'finishRating', sh.finish_rating, 'finishTier', sh.finish_tier,
          'endedAt', (extract(epoch FROM sh.ended_at) * 1000)::bigint
        ) AS value FROM economy.season_history sh
        WHERE sh.actor_id = a.actor_id ORDER BY sh.seq LIMIT 20000
      ) entries
    ), '[]'::json),
    'tournamentRecord', CASE WHEN tr.actor_id IS NULL THEN NULL ELSE json_build_object(
      'entered', tr.entered, 'wins', tr.wins, 'runnerUp', tr.runner_up,
      'top3', tr.top3, 'top5', tr.top5, 'bestFinish', tr.best_finish,
      'finishSum', tr.finish_sum, 'premiumWins', tr.premium_wins
    ) END,
    'history', COALESCE((
      SELECT json_agg(entries.value ORDER BY entries.seq) FROM (
        SELECT h.seq, json_build_object(
          'id', h.match_id, 'mode', h.mode, 'result', h.result,
          'activeSeconds', h.active_seconds, 'at', (extract(epoch FROM h.at) * 1000)::bigint,
          'opponent', h.opponent, 'queue', h.queue, 'symbol', h.symbol,
          'rated', h.rated, 'qualified', h.qualified, 'activityQualified', h.activity_qualified,
          'reason', h.reason, 'ratingDelta', h.rating_delta, 'casualDelta', h.casual_delta
        ) AS value FROM economy.match_history h
        WHERE h.actor_id = a.actor_id ORDER BY h.seq LIMIT 20000
      ) entries
    ), '[]'::json)
  ) INTO result
  FROM identity.actors a
  LEFT JOIN economy.wallets w ON w.actor_id = a.actor_id
  LEFT JOIN economy.ratings r ON r.actor_id = a.actor_id
  LEFT JOIN core.actor_occupancy o ON o.actor_id = a.actor_id
  LEFT JOIN economy.season_state s ON s.actor_id = a.actor_id
  LEFT JOIN economy.tournament_records tr ON tr.actor_id = a.actor_id
  LEFT JOIN monetization.credits c ON c.actor_id = a.actor_id
  WHERE a.actor_id = p_actor;

  -- Match the existing repository's children bound. Never publish a silently truncated
  -- history/ownership projection; qualification still belongs to the shared domain policy.
  IF json_array_length(result->'history') >= 20000
     OR json_array_length(result->'seasonHistory') >= 20000
     OR json_array_length(result->'wealth'->'owned') >= 20000 THEN
    RAISE EXCEPTION 'STATE_TRUNCATED' USING ERRCODE = '54000';
  END IF;
  RETURN result;
END;
$function$;

REVOKE ALL ON FUNCTION identity.auth_credential(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.auth_challenge(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.auth_signin_attempt(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION profile.account_state(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.auth_credential(text, text), identity.auth_challenge(text, text),
  identity.auth_signin_attempt(text), profile.account_state(text) TO api_runtime;
