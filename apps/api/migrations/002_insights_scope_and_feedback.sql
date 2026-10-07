-- Two-level insight cache:
--   scope_key: (account, range, prompt version, model) -> reuse a recent answer for 15 min while live data moves
--   cache_key: hash of the exact facts -> identical facts never pay for a second generation
ALTER TABLE insight_cache ADD COLUMN scope_key text;
CREATE INDEX insight_cache_scope ON insight_cache (account_id, scope_key, created_at DESC);

-- Feedback keeps what the user actually saw, so a thumbs-down can become an eval case without guesswork.
ALTER TABLE insight_feedback
  ADD COLUMN insight jsonb,
  ADD COLUMN facts   jsonb,
  ADD COLUMN comment text;
