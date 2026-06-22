// ─────────────────────────────────────────────────────────────────────────────
// GymLead AI — Type Definitions
// ─────────────────────────────────────────────────────────────────────────────

export type Plan = 'starter' | 'growth' | 'enterprise';

// 'qualified' is kept in the type but the AI prompt must also list it.
// Both the SQL CHECK constraint and the TypeScript union must stay in sync.
export type LeadStatus =
  | 'new'
  | 'contacted'
  | 'qualified'
  | 'hot'
  | 'warm'
  | 'cold'
  | 'converted'
  | 'lost'
  | 'renewal_due';

export type Gender = 'male' | 'female' | 'other' | 'unknown';
export type LeadSource = 'whatsapp' | 'website' | 'referral' | 'walkin' | 'manual';
export type MessageDirection = 'inbound' | 'outbound';
export type MessageSender = 'lead' | 'ai' | 'human' | 'system';
export type FollowUpType =
  | 'initial_response'
  | 'day1_followup'
  | 'day3_followup'
  | 'day7_followup'
  | 'renewal_reminder'
  | 'custom';
export type ActivityType =
  | 'created'
  | 'message_received'
  | 'message_sent'
  | 'status_changed'
  | 'score_updated'
  | 'follow_up_sent'
  | 'converted'
  | 'plan_assigned'
  | 'ai_summary_generated'
  | 'note_added'
  | 'renewal_reminder_sent';
export type KnowledgeCategory =
  | 'membership_plans'
  | 'facilities'
  | 'trainers'
  | 'timings'
  | 'fees'
  | 'policies'
  | 'promotions'
  | 'location'
  | 'faq'
  | 'general';
export type SummaryType =
  | 'lead_summary'
  | 'daily_digest'
  | 'conversion_alert'
  | 'renewal_alert';

// ─── Database Row Types ───────────────────────────────────────────────────────

export interface Gym {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  phone_number: string | null;
  whatsapp_token: string | null;
  phone_number_id: string | null;
  wa_verify_token: string | null;
  address: string | null;
  website: string | null;
  logo_url: string | null;
  timezone: string;
  currency: string;
  plan: Plan;
  is_active: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface GymKnowledge {
  id: string;
  gym_id: string;
  category: KnowledgeCategory;
  title: string;
  content: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Lead {
  id: string;
  gym_id: string;
  phone: string;
  name: string | null;
  email: string | null;
  age: number | null;
  gender: Gender;
  status: LeadStatus;
  score: number;
  interests: string[];
  interested_plan: string | null;
  budget_range: string | null;
  converted_at: string | null;
  membership_type: string | null;
  membership_start: string | null;
  membership_end: string | null;
  monthly_fee: number | null;
  source: LeadSource;
  referred_by: string | null;
  ai_summary: string | null;
  ai_tags: string[];
  last_ai_analysis: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  gym_id: string;
  lead_id: string | null;
  wa_thread_id: string | null;
  phone: string;
  status: 'active' | 'resolved' | 'snoozed' | 'archived';
  last_message_at: string | null;
  message_count: number;
  ai_handled: boolean;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  gym_id: string;
  wa_message_id: string | null;
  direction: MessageDirection;
  sender: MessageSender;
  content: string;
  media_type: string | null;
  media_url: string | null;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  ai_confidence: number | null;
  tokens_used: number | null;
  created_at: string;
}

export interface FollowUp {
  id: string;
  gym_id: string;
  lead_id: string;
  conversation_id: string | null;
  type: FollowUpType;
  message_template: string;
  scheduled_at: string;
  sent_at: string | null;
  status: 'pending' | 'sent' | 'cancelled' | 'failed';
  attempt_count: number;
  error_message: string | null;
  created_at: string;
}

export interface LeadActivity {
  id: string;
  gym_id: string;
  lead_id: string;
  type: ActivityType;
  description: string;
  old_value: string | null;
  new_value: string | null;
  actor: 'ai' | 'human' | 'system';
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AiSummary {
  id: string;
  gym_id: string;
  lead_id: string | null;
  type: SummaryType;
  title: string;
  content: string;
  sent_via: string[];
  is_read: boolean;
  created_at: string;
}

export interface MembershipPlan {
  id: string;
  gym_id: string;
  name: string;
  duration: number;
  price: number;
  features: string[];
  is_active: boolean;
  sort_order: number;
  created_at: string;
}

// ─── Request / Response Types ──────────────────────────────────────────────

export interface WhatsAppWebhookBody {
  object: string;
  entry: WhatsAppEntry[];
}

export interface WhatsAppEntry {
  id: string;
  changes: WhatsAppChange[];
}

export interface WhatsAppChange {
  value: WhatsAppValue;
  field: string;
}

export interface WhatsAppValue {
  messaging_product: string;
  metadata: { display_phone_number: string; phone_number_id: string };
  contacts?: Array<{ profile: { name: string }; wa_id: string }>;
  messages?: WhatsAppMessage[];
  statuses?: WhatsAppStatus[];
}

export interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { caption?: string; mime_type: string; sha256: string; id: string };
  audio?: { mime_type: string; sha256: string; id: string; voice: boolean };
}

export interface WhatsAppStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
}

// ─── AI Types ────────────────────────────────────────────────────────────────

export interface AIRespondInput {
  gym: Gym;
  gymKnowledge: GymKnowledge[];
  lead: Lead;
  conversationHistory: Message[];
  incomingMessage: string;
}

export interface AIRespondOutput {
  reply: string;
  leadUpdate: Partial<Lead>;
  scheduleFollowUp: boolean;
  followUpDelay: number; // hours
  confidence: number;
  tokensUsed: number;
}

export interface AILeadSummaryInput {
  lead: Lead;
  messages: Message[];
  activities: LeadActivity[];
  gym: Gym;
}

// ─── Dashboard Types ──────────────────────────────────────────────────────────

export interface DashboardStats {
  totalLeads: number;
  newLeadsToday: number;
  hotLeads: number;
  convertedThisMonth: number;
  conversionRate: number;
  renewalsDue: number;
  pendingFollowUps: number;
  activeConversations: number;
  revenueThisMonth: number;
  avgLeadScore: number;
}

export interface LeadFunnelData {
  stage: string;
  count: number;
  percentage: number;
  color: string;
}

export interface ConversionTrendData {
  date: string;
  leads: number;
  conversions: number;
}
