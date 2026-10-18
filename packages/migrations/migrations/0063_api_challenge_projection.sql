-- runner: current-role
-- V5 launch fix (2026-10-18): the contracted GET /api/community/challenges route had no V5
-- implementation (the mounted API answered 404, so the signed clients showed a permanent
-- "Connection interrupted" state after sign-in). The API tier must not read match.* directly
-- (0020), so this is the sanctioned P04-shaped narrow SECURITY DEFINER export: exactly the
-- caller's own OFFERED, unaccepted, unexpired matches, with no economy mutation surface.
-- Row visibility follows the same rule compat.js uses for /api/v1/invitations; the API route
-- layers the display projection and the queue-source filter on top of this durable read.
CREATE OR REPLACE FUNCTION profile.challenges_for(p_actor text)
RETURNS TABLE (
  match_id text,
  source text,
  status text,
  terms jsonb,
  terms_hash char(64),
  quote jsonb,
  created bigint,
  expires bigint,
  players jsonb,
  accepted jsonb,
  player_names jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT m.match_id,
         m.source,
         m.status,
         m.terms_json,
         m.terms_hash,
         m.quote_json,
         (extract(epoch FROM m.created_at) * 1000)::bigint,
         (extract(epoch FROM m.expires_at) * 1000)::bigint,
         (SELECT json_agg(p2.actor_id ORDER BY p2.seat)
            FROM match.participants p2 WHERE p2.match_id = m.match_id),
         (SELECT json_agg(p3.actor_id ORDER BY p3.seat)
            FROM match.participants p3 WHERE p3.match_id = m.match_id AND p3.accepted = true),
         (SELECT jsonb_object_agg(p4.actor_id, COALESCE(pr.display_name, 'Player'))
            FROM match.participants p4
            LEFT JOIN identity.profiles pr ON pr.actor_id = p4.actor_id
           WHERE p4.match_id = m.match_id)
    FROM match.matches m
   WHERE m.status = 'OFFERED'
     AND m.expires_at > now()
     AND EXISTS (
       SELECT 1 FROM match.participants p
        WHERE p.match_id = m.match_id
          AND p.actor_id = p_actor
          AND p.accepted = false
     )
   ORDER BY m.created_at DESC
   LIMIT 50;
$function$;

REVOKE ALL ON FUNCTION profile.challenges_for(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION profile.challenges_for(text) TO api_runtime;
