-- Accounts are tenants. Every other table carries account_id and every query filters by it.
CREATE TABLE accounts (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  timezone    text NOT NULL,              -- IANA zone, e.g. America/Los_Angeles
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaigns (
  id          uuid PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id),
  name        text NOT NULL,
  source      text NOT NULL CHECK (source IN ('google_ads','meta','tv','organic','direct_mail','affiliate')),
  archived_at timestamptz,
  UNIQUE (account_id, name)
);

-- Current state of each call (the projection). Status is text + CHECK rather than an enum so adding a status
-- later is a one-line migration.
CREATE TABLE calls (
  id             uuid PRIMARY KEY,
  account_id     uuid NOT NULL REFERENCES accounts(id),
  campaign_id    uuid NOT NULL REFERENCES campaigns(id),
  status         text NOT NULL CHECK (status IN ('ringing','connected','missed','converted')),
  started_at     timestamptz NOT NULL,
  answered_at    timestamptz,
  ended_at       timestamptz,
  converted_at   timestamptz,
  duration_sec   integer CHECK (duration_sec >= 0),
  caller_masked  text,                    -- raw numbers are never stored
  caller_region  text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calls_feed_idx ON calls (account_id, started_at DESC, id DESC);
CREATE INDEX calls_campaign_idx ON calls (account_id, campaign_id, started_at DESC);

-- Append-only event log: audit trail, idempotency (event_id), and the replay cursor (seq) for the live feed.
CREATE TABLE call_events (
  seq           bigserial PRIMARY KEY,
  event_id      uuid NOT NULL UNIQUE,
  account_id    uuid NOT NULL,
  call_id       uuid NOT NULL,
  type          text NOT NULL,
  occurred_at   timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  applied       boolean NOT NULL DEFAULT true,
  reject_reason text,
  payload       jsonb NOT NULL
);
CREATE INDEX call_events_replay_idx ON call_events (account_id, seq);
CREATE INDEX call_events_received_idx ON call_events (received_at);

-- Pre-aggregated counts per account x campaign x UTC hour of the call's START time. Each call is counted exactly
-- once, in the column of its current status. A status change is -1 on the old column and +1 on the new one.
CREATE TABLE call_stats_hourly (
  account_id    uuid        NOT NULL,
  bucket_start  timestamptz NOT NULL,
  campaign_id   uuid        NOT NULL,
  ringing       integer NOT NULL DEFAULT 0,
  connected     integer NOT NULL DEFAULT 0,
  missed        integer NOT NULL DEFAULT 0,
  converted     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, bucket_start, campaign_id)
);

-- AI insights: generated output cached by (prompt version, model, facts hash), plus user feedback.
CREATE TABLE insight_cache (
  account_id  uuid NOT NULL,
  cache_key   text NOT NULL,
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (account_id, cache_key)
);

CREATE TABLE insight_feedback (
  id             bigserial PRIMARY KEY,
  account_id     uuid NOT NULL,
  cache_key      text NOT NULL,
  insight_id     text NOT NULL,
  rating         smallint NOT NULL CHECK (rating IN (-1, 1)),
  prompt_version text NOT NULL,
  model          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Lets the simulator resume after the free host sleeps.
CREATE TABLE simulator_state (
  account_id            uuid PRIMARY KEY,
  last_generated_minute timestamptz NOT NULL
);
