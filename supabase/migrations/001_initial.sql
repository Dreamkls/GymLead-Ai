-- GymLead AI — Full Multi-Tenant Schema
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
--
-- REQUIREMENTS:
--   pg_cron and pg_net require a Supabase Pro plan or higher.
--   On the free tier, remove those two CREATE EXTENSION lines — cron jobs
--   are handled by Vercel (vercel.json) and do not need pg_cron.

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Only enable these on Pro+ plans:
-- CREATE EXTENSION IF NOT EXISTS "pg_cron";
-- CREATE EXTENSION IF NOT EXISTS "pg_net";

-- ─────────────────────────────────────────────
-- GYMS (multi-tenant root table)
-- ─────────────────────────────────────────────
CREATE TABLE gyms (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  slug             TEXT UNIQUE NOT NULL,
  phone_number     TEXT,              -- WhatsApp business number (display)
  whatsapp_token   TEXT,              -- Meta WhatsApp API token — store encrypted in production
  phone_number_id  TEXT,              -- Meta phone number ID
  wa_verify_token  TEXT,              -- Webhook verify token (set per gym, random string)
  address          TEXT,
  website          TEXT,
  logo_url         TEXT,
  timezone         TEXT DEFAULT 'Asia/Kolkata',
  currency         TEXT DEFAULT 'INR',
  plan             TEXT DEFAULT 'starter' CHECK (plan IN ('starter', 'growth', 'enterprise')),
  is_active        BOOLEAN DEFAULT TRUE,
  metadata         JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- GYM KNOWLEDGE BASE (AI context per gym)
-- ─────────────────────────────────────────────
CREATE TABLE gym_knowledge (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gym_id      UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  category    TEXT NOT NULL CHECK (category IN (
    'membership_plans', 'facilities', 'trainers', 'timings',
    'fees', 'policies', 'promotions', 'location', 'faq', 'general'
  )),
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- LEADS
-- ─────────────────────────────────────────────
CREATE TABLE leads (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gym_id          UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  phone           TEXT NOT NULL,
  name            TEXT,
  email           TEXT,
  age             INT,
  gender          TEXT CHECK (gender IN ('male', 'female', 'other', 'unknown')),
  -- Classification
  status          TEXT DEFAULT 'new' CHECK (status IN (
    'new', 'contacted', 'qualified', 'hot', 'warm', 'cold',
    'converted', 'lost', 'renewal_due'
  )),
  score           INT DEFAULT 0 CHECK (score >= 0 AND score <= 100),
  -- Interest signals
  interests       TEXT[] DEFAULT '{}',
  interested_plan TEXT,
  budget_range    TEXT,
  -- Conversion
  converted_at    TIMESTAMPTZ,
  membership_type TEXT,
  membership_start DATE,
  membership_end   DATE,
  monthly_fee     DECIMAL(10,2),
  -- Attribution
  source          TEXT DEFAULT 'whatsapp' CHECK (source IN (
    'whatsapp', 'website', 'referral', 'walkin', 'manual'
  )),
  referred_by     UUID REFERENCES leads(id),
  -- AI fields
  ai_summary      TEXT,
  ai_tags         TEXT[] DEFAULT '{}',
  last_ai_analysis TIMESTAMPTZ,
  -- Metadata
  notes           TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  -- One lead record per phone number per gym
  UNIQUE(gym_id, phone)
);

-- ─────────────────────────────────────────────
-- CONVERSATIONS (WhatsApp threads)
-- ─────────────────────────────────────────────
CREATE TABLE conversations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gym_id          UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  lead_id         UUID REFERENCES leads(id) ON DELETE SET NULL,
  wa_thread_id    TEXT,
  phone           TEXT NOT NULL,
  status          TEXT DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'snoozed', 'archived')),
  last_message_at TIMESTAMPTZ,
  message_count   INT DEFAULT 0,
  ai_handled      BOOLEAN DEFAULT TRUE,
  assigned_to     UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  -- BUG FIX: this constraint was missing in the original schema.
  -- The webhook upserts conversations on (gym_id, phone); without this unique
  -- constraint the upsert silently creates duplicate rows instead of updating.
  UNIQUE(gym_id, phone)
);

-- ─────────────────────────────────────────────
-- MESSAGES
-- ─────────────────────────────────────────────
CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  gym_id          UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  wa_message_id   TEXT UNIQUE,        -- WhatsApp message ID for deduplication
  direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender          TEXT NOT NULL CHECK (sender IN ('lead', 'ai', 'human', 'system')),
  content         TEXT NOT NULL,
  media_type      TEXT,
  media_url       TEXT,
  status          TEXT DEFAULT 'sent' CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
  ai_confidence   FLOAT,
  tokens_used     INT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- FOLLOW UPS
-- ─────────────────────────────────────────────
CREATE TABLE follow_ups (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gym_id          UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id),
  type            TEXT NOT NULL CHECK (type IN (
    'initial_response', 'day1_followup', 'day3_followup',
    'day7_followup', 'renewal_reminder', 'custom'
  )),
  message_template TEXT NOT NULL,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  sent_at         TIMESTAMPTZ,
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
  attempt_count   INT DEFAULT 0,
  error_message   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- LEAD ACTIVITIES (audit trail + timeline)
-- ─────────────────────────────────────────────
CREATE TABLE lead_activities (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gym_id      UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  lead_id     UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN (
    'created', 'message_received', 'message_sent', 'status_changed',
    'score_updated', 'follow_up_sent', 'converted', 'plan_assigned',
    'ai_summary_generated', 'note_added', 'renewal_reminder_sent'
  )),
  description TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  actor       TEXT DEFAULT 'ai' CHECK (actor IN ('ai', 'human', 'system')),
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- AI SUMMARIES (notifications for gym owner)
-- ─────────────────────────────────────────────
CREATE TABLE ai_summaries (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gym_id      UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  lead_id     UUID REFERENCES leads(id) ON DELETE SET NULL,
  type        TEXT NOT NULL CHECK (type IN (
    'lead_summary', 'daily_digest', 'conversion_alert', 'renewal_alert'
  )),
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  sent_via    TEXT[] DEFAULT '{}',
  is_read     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- MEMBERSHIP PLANS (gym's plan catalogue)
-- ─────────────────────────────────────────────
CREATE TABLE membership_plans (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gym_id      UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  duration    INT NOT NULL,           -- in days
  price       DECIMAL(10,2) NOT NULL,
  features    TEXT[] DEFAULT '{}',
  is_active   BOOLEAN DEFAULT TRUE,
  sort_order  INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────
CREATE INDEX idx_leads_gym_id        ON leads(gym_id);
CREATE INDEX idx_leads_status        ON leads(status);
CREATE INDEX idx_leads_phone         ON leads(phone);
CREATE INDEX idx_leads_created_at    ON leads(created_at DESC);
CREATE INDEX idx_leads_score         ON leads(score);
CREATE INDEX idx_conversations_gym   ON conversations(gym_id);
CREATE INDEX idx_conversations_lead  ON conversations(lead_id);
CREATE INDEX idx_messages_conv       ON messages(conversation_id);
CREATE INDEX idx_messages_created    ON messages(created_at DESC);
CREATE INDEX idx_messages_gym        ON messages(gym_id);
CREATE INDEX idx_follow_ups_sched    ON follow_ups(scheduled_at) WHERE status = 'pending';
CREATE INDEX idx_follow_ups_lead     ON follow_ups(lead_id);
CREATE INDEX idx_activities_lead     ON lead_activities(lead_id);
CREATE INDEX idx_activities_gym      ON lead_activities(gym_id);
CREATE INDEX idx_activities_created  ON lead_activities(created_at DESC);
CREATE INDEX idx_ai_summaries_gym    ON ai_summaries(gym_id);

-- ─────────────────────────────────────────────
-- ROW LEVEL SECURITY (RLS)
-- ─────────────────────────────────────────────
ALTER TABLE gyms             ENABLE ROW LEVEL SECURITY;
ALTER TABLE gym_knowledge    ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads            ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages         ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_ups       ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_activities  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_summaries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_plans ENABLE ROW LEVEL SECURITY;

-- Gyms: owner can see and manage their own gym(s)
CREATE POLICY "gym_owner_all" ON gyms
  FOR ALL USING (owner_id = auth.uid());

-- Service role bypasses RLS for API routes and cron jobs
CREATE POLICY "service_role_all_gyms" ON gyms
  FOR ALL USING (auth.role() = 'service_role');

-- Apply owner + service-role policies to all child tables
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'gym_knowledge', 'leads', 'conversations', 'messages',
    'follow_ups', 'lead_activities', 'ai_summaries', 'membership_plans'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY "owner_all_%s" ON %I
       FOR ALL USING (gym_id IN (SELECT id FROM gyms WHERE owner_id = auth.uid()));',
      tbl, tbl
    );
    EXECUTE format(
      'CREATE POLICY "service_all_%s" ON %I
       FOR ALL USING (auth.role() = ''service_role'');',
      tbl, tbl
    );
  END LOOP;
END;
$$;

-- ─────────────────────────────────────────────
-- UPDATED_AT TRIGGER
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_gyms_updated
  BEFORE UPDATE ON gyms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_gym_knowledge_updated
  BEFORE UPDATE ON gym_knowledge
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_leads_updated
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_conversations_updated
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─────────────────────────────────────────────
-- SEED: placeholder — gym owners configure their
-- own knowledge base via Settings → Knowledge Base
-- ─────────────────────────────────────────────
