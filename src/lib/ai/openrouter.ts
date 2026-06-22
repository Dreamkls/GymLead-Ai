// src/lib/ai/openrouter.ts
// ─────────────────────────────────────────────────────────────────────────────
// OpenRouter client — Google Gemini 2.0 Flash
// Handles: gym Q&A, lead classification, follow-up generation, summaries
// ─────────────────────────────────────────────────────────────────────────────

import type { AIRespondInput, AIRespondOutput, AILeadSummaryInput, Lead } from '@/types';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const MODEL = 'google/gemini-2.0-flash-001';

interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenRouterResponse {
  id: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

async function callOpenRouter(
  messages: OpenRouterMessage[],
  options: { temperature?: number; max_tokens?: number } = {}
): Promise<{ content: string; tokensUsed: number }> {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL ?? 'https://gymlead.ai',
      'X-Title': 'GymLead AI',
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: options.temperature ?? 0.4,
      max_tokens: options.max_tokens ?? 1024,
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${error}`);
  }

  const data: OpenRouterResponse = await res.json();
  return {
    content: data.choices[0].message.content,
    tokensUsed: data.usage.total_tokens,
  };
}

// ─── Safely parse JSON from AI output ────────────────────────────────────────
function parseJSON<T>(text: string, fallback: T): T {
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean) as T;
  } catch {
    return fallback;
  }
}

// ─── 1. Generate AI reply to a WhatsApp inquiry ───────────────────────────────
export async function generateGymReply(input: AIRespondInput): Promise<AIRespondOutput> {
  const { gym, gymKnowledge, lead, conversationHistory, incomingMessage } = input;

  const knowledgeText = gymKnowledge
    .filter((k) => k.is_active)
    .map((k) => `[${k.category.toUpperCase()}] ${k.title}:\n${k.content}`)
    .join('\n\n');

  const historyText = conversationHistory
    .slice(-10)
    .map((m) => `${m.sender === 'lead' ? 'Customer' : 'Assistant'}: ${m.content}`)
    .join('\n');

  const systemPrompt = `You are an AI sales assistant for "${gym.name}", a fitness center.
You help potential members via WhatsApp — answer questions, qualify leads, and drive conversions.

ABOUT THIS GYM:
${knowledgeText || 'No knowledge base configured yet. Answer generally about gym membership.'}

CUSTOMER PROFILE:
- Name: ${lead.name ?? 'Unknown'}
- Status: ${lead.status}
- Lead Score: ${lead.score}/100
- Interests: ${lead.interests.join(', ') || 'Not yet known'}

RESPONSE RULES:
1. Be friendly, concise (2-4 sentences max), and reply in the same language as the customer
2. Answer questions using ONLY the provided gym knowledge
3. Gently guide toward booking a trial or membership
4. If asked about pricing, give exact amounts from the knowledge base
5. Never make up information not in the knowledge base
6. End with a clear call-to-action when appropriate

After your response, on a new line output JSON (no markdown):
{"lead_update":{"name":"<if mentioned>","status":"<new_status>","score":<0-100>,"interests":<array>,"interested_plan":"<if mentioned>"},"schedule_followup":<true/false>,"followup_hours":<24|72|168>,"confidence":<0.0-1.0>}

Status options: new, contacted, qualified, warm, hot, converted, cold, lost
Score rubric: +10 general question, +20 pricing inquiry, +30 trial request, +40 ready to join`;

  const messages: OpenRouterMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(historyText
      ? [{ role: 'user' as const, content: `Previous conversation:\n${historyText}` }]
      : []),
    { role: 'user', content: `Customer message: ${incomingMessage}` },
  ];

  const { content, tokensUsed } = await callOpenRouter(messages, {
    temperature: 0.3,
    max_tokens: 512,
  });

  // Split reply and trailing JSON block
  const jsonMatch = content.match(/\{[\s\S]*\}$/);
  const reply = jsonMatch
    ? content.slice(0, content.indexOf(jsonMatch[0])).trim()
    : content.trim();

  interface AIJSONOutput {
    lead_update?: Partial<Lead>;
    schedule_followup?: boolean;
    followup_hours?: number;
    confidence?: number;
  }

  const aiJson = parseJSON<AIJSONOutput>(jsonMatch?.[0] ?? '{}', {});

  return {
    reply,
    leadUpdate: aiJson.lead_update ?? {},
    scheduleFollowUp: aiJson.schedule_followup ?? false,
    followUpDelay: aiJson.followup_hours ?? 24,
    confidence: aiJson.confidence ?? 0.8,
    tokensUsed,
  };
}

// ─── 2. Classify / re-score a lead from recent messages ──────────────────────
export async function classifyLead(
  lead: Lead,
  recentMessages: string[]
): Promise<{ status: Lead['status']; score: number; tags: string[] }> {
  const messages: OpenRouterMessage[] = [
    {
      role: 'system',
      content: `You are a gym lead scoring specialist. Analyze the conversation and output ONLY JSON.
Scoring rubric:
- 0-20: Just curious, no real intent
- 21-40: Asking general questions (Cold)
- 41-60: Asking about prices/plans (Warm / Qualified)
- 61-80: Requesting trial/visit (Hot)
- 81-100: Ready to sign up (Hot/Converted)

Status options: new, contacted, qualified, warm, hot, converted, cold, lost

Tags (pick relevant): weight_loss, muscle_gain, yoga, cardio, personal_training, group_classes,
swimming, boxing, zumba, student_discount, corporate_plan, family_plan, trial_requested,
price_sensitive, decided`,
    },
    {
      role: 'user',
      content: `Lead: ${lead.name ?? 'Unknown'}, current status: ${lead.status}, current score: ${lead.score}
Recent messages: ${recentMessages.slice(-5).join(' | ')}

Output JSON: {"status":"<status>","score":<0-100>,"tags":["<tag>"]}`,
    },
  ];

  const { content } = await callOpenRouter(messages, { temperature: 0.1, max_tokens: 128 });

  interface ClassifyOutput {
    status?: Lead['status'];
    score?: number;
    tags?: string[];
  }

  const result = parseJSON<ClassifyOutput>(content, {});
  return {
    status: result.status ?? lead.status,
    score: result.score ?? lead.score,
    tags: result.tags ?? lead.ai_tags,
  };
}

// ─── 3. Generate a lead summary for the gym owner ─────────────────────────────
export async function generateLeadSummary(input: AILeadSummaryInput): Promise<string> {
  const { lead, messages, activities, gym } = input;

  const timeline = activities
    .slice(-20)
    .map((a) => `[${new Date(a.created_at).toLocaleDateString()}] ${a.description}`)
    .join('\n');

  const conversation = messages
    .slice(-10)
    .map((m) => `${m.sender === 'lead' ? '👤' : '🤖'} ${m.content}`)
    .join('\n');

  const systemPrompt = `You write concise lead intelligence summaries for gym owners.
Write in a professional but warm tone. Use bullet points. Max 200 words.
Include: lead interest level, what they asked about, recommended next action, and any red flags.`;

  const userPrompt = `Gym: ${gym.name}
Lead: ${lead.name ?? lead.phone} | Score: ${lead.score}/100 | Status: ${lead.status}
Interests: ${lead.interests.join(', ') || 'Unknown'}
Interested in: ${lead.interested_plan ?? 'Not specified'}

Recent activity:
${timeline || 'No activities yet'}

Recent conversation:
${conversation || 'No messages yet'}

Write a summary for the gym owner.`;

  const { content } = await callOpenRouter(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    { temperature: 0.5, max_tokens: 300 }
  );

  return content;
}

// ─── 4. Generate a personalised follow-up message ─────────────────────────────
// Uses static templates as the base. The 24h follow-up is sent free-form;
// the 3-day and 7-day variants must be sent via approved WhatsApp Templates
// (see src/lib/whatsapp/client.ts → sendWhatsAppTemplate).
export async function generateFollowUpMessage(
  lead: Lead,
  followUpType: string,
  gym: { name: string; phone: string | null }
): Promise<string> {
  const templates: Record<string, string> = {
    day1_followup: `Hey {name}! Just following up on your inquiry about ${gym.name}. Have you had a chance to think about joining us? We'd love to give you a free trial session! 🏋️`,
    day3_followup: `Hi {name}! It's been a few days since we chatted. Our special offer is still available — would you like to come in and see the gym for yourself? No commitment needed!`,
    day7_followup: `Hey {name}! Last chance to grab our current membership offer at ${gym.name}. Reply YES if you're interested and we'll reserve a spot for you! 💪`,
    renewal_reminder: `Hi {name}! Your membership at ${gym.name} is due for renewal soon. Reply to this message to get our exclusive renewal discount. We'd love to keep you on the team! 🎯`,
  };

  const template = templates[followUpType] ?? templates.day1_followup;
  return template.replace('{name}', lead.name ?? 'there');
}

// ─── 5. Generate the daily digest message ─────────────────────────────────────
export async function generateDailyDigest(stats: {
  gymName: string;
  newLeads: number;
  hotLeads: number;
  converted: number;
  pendingFollowUps: number;
  renewalsDue: number;
  topInterests: string[];
}): Promise<string> {
  return `📊 *GymLead AI Daily Digest — ${stats.gymName}*
${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}

🆕 New inquiries today: ${stats.newLeads}
🔥 Hot leads: ${stats.hotLeads}
✅ Converted today: ${stats.converted}
📅 Follow-ups pending: ${stats.pendingFollowUps}
⚠️ Renewals due: ${stats.renewalsDue}

💡 Top interests: ${stats.topInterests.join(', ') || 'N/A'}

_Powered by GymLead AI_ 🤖`;
}
