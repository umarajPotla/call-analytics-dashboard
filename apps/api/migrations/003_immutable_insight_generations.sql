-- Every generation is stored once and never changed, so feedback always refers to exactly what the user saw.
-- (Before: one mutable cache row per facts hash; a regeneration could overwrite the text a thumbs-down was for,
-- and two ranges with identical facts overwrote each other's freshness window.)
CREATE TABLE insight_generations (
  id          uuid PRIMARY KEY,
  account_id  uuid NOT NULL,
  cache_key   text NOT NULL,          -- content address: hash(prompt version, model, facts)
  payload     jsonb NOT NULL,         -- the full response the user was shown
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL    -- reusable for identical facts until then
);
CREATE INDEX insight_generations_key ON insight_generations (account_id, cache_key, created_at DESC);

-- Freshness window: which generation answers (account, range, prompt version, model) right now.
CREATE TABLE insight_scopes (
  account_id    uuid NOT NULL,
  scope_key     text NOT NULL,
  generation_id uuid NOT NULL REFERENCES insight_generations (id) ON DELETE CASCADE,
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (account_id, scope_key)
);

ALTER TABLE insight_feedback ADD COLUMN generation_id uuid;
DROP TABLE insight_cache;
