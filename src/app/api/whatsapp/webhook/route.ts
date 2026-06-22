// src/app/api/whatsapp/webhook/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp Cloud API Webhook
//
// GET  → Meta verification challenge
// POST → Incoming messages + status updates
//
// Processing pipeline:
//   1. Verify HMAC-SHA256 signature (mandatory — rejects if secret not set)
//   2. Find gym by phone_number_id
//   3. Upsert lead
//   4. Upsert conversation
//   5. Deduplicate by wa_message_id
//   6. Save incoming message
//   7. Log activity
//   8. Mark message as read
//   9. Load conversation history
//  10. Load gym knowledge base
//  11. Generate AI reply
//  12. Send reply via WhatsApp
//  13. Save outgoing message
//  14. Update lead with AI classification
//  15. Schedule follow-up if AI recommends it
//  16. Notify gym owner if lead is hot or converted
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { generateGymReply } from '@/lib/ai/openrouter';
import {
  sendWhatsAppMessage,
  markMessageAsRead,
  verifyWebhookSignature,
  extractIncomingMessage,
} from '@/lib/whatsapp/client';
import type { Lead, Conversation, Message, Gym, GymKnowledge } from '@/types';

// ─── GET: Meta webhook verification ──────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token) {
    const supabase = createServiceClient();
    const { data: gym } = await supabase
      .from('gyms')
      .select('id')
      .eq('wa_verify_token', token)
      .single();

    if (gym) {
      return new NextResponse(challenge, { status: 200 });
    }
  }

  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

// ─── POST: Incoming WhatsApp messages ────────────────────────────────────────
export async function POST(req: NextRequest) {
  // 1. Read raw body and verify signature — mandatory, no bypass
  const rawBody = await req.text();
  const signature = req.headers.get('x-hub-signature-256') ?? '';
  const appSecret = process.env.WHATSAPP_APP_SECRET;

  if (!appSecret) {
    console.error('[Webhook] WHATSAPP_APP_SECRET is not set — rejecting request');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  if (!verifyWebhookSignature(rawBody, signature, appSecret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // 2. Extract the incoming text message
  const incoming = extractIncomingMessage(body);
  if (!incoming) {
    // Status update or unsupported type — always acknowledge to prevent Meta retries
    return NextResponse.json({ status: 'ok' });
  }

  const supabase = createServiceClient();

  try {
    // 3. Find gym by phone_number_id
    const { data: gym, error: gymErr } = await supabase
      .from('gyms')
      .select('*')
      .eq('phone_number_id', incoming.phoneNumberId)
      .eq('is_active', true)
      .single<Gym>();

    if (gymErr || !gym) {
      console.error('[Webhook] Gym not found for phoneNumberId:', incoming.phoneNumberId);
      return NextResponse.json({ status: 'ok' }); // Acknowledge to Meta
    }

    // 4. Upsert lead (one record per phone per gym)
    const { data: lead } = await supabase
      .from('leads')
      .upsert(
        {
          gym_id: gym.id,
          phone: incoming.from,
          name: incoming.senderName || null,
          source: 'whatsapp',
          status: 'new',
          score: 0,
        },
        { onConflict: 'gym_id,phone', ignoreDuplicates: false }
      )
      .select()
      .single<Lead>();

    if (!lead) throw new Error('Failed to upsert lead');

    // 5. Upsert conversation — requires UNIQUE(gym_id, phone) on conversations table
    const { data: conversation } = await supabase
      .from('conversations')
      .upsert(
        {
          gym_id: gym.id,
          lead_id: lead.id,
          phone: incoming.from,
          status: 'active',
          last_message_at: new Date().toISOString(),
        },
        { onConflict: 'gym_id,phone', ignoreDuplicates: false }
      )
      .select()
      .single<Conversation>();

    if (!conversation) throw new Error('Failed to upsert conversation');

    // 6. Deduplicate: skip if we've already processed this WA message ID
    const { data: existingMsg } = await supabase
      .from('messages')
      .select('id')
      .eq('wa_message_id', incoming.messageId)
      .single();

    if (existingMsg) {
      return NextResponse.json({ status: 'ok' });
    }

    // 7. Save incoming message
    await supabase.from('messages').insert({
      conversation_id: conversation.id,
      gym_id: gym.id,
      wa_message_id: incoming.messageId,
      direction: 'inbound',
      sender: 'lead',
      content: incoming.text,
      status: 'delivered',
    });

    // 8. Log activity
    await supabase.from('lead_activities').insert({
      gym_id: gym.id,
      lead_id: lead.id,
      type: 'message_received',
      description: 'Sent a WhatsApp message',
      actor: 'system',
    });

    // 9. Mark incoming message as read
    if (gym.phone_number_id && gym.whatsapp_token) {
      await markMessageAsRead(gym.phone_number_id, gym.whatsapp_token, incoming.messageId);
    }

    // 10. Load conversation history (last 15 messages for context)
    const { data: history } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: true })
      .limit(15)
      .returns<Message[]>();

    // 11. Load gym knowledge base
    const { data: knowledge } = await supabase
      .from('gym_knowledge')
      .select('*')
      .eq('gym_id', gym.id)
      .eq('is_active', true)
      .returns<GymKnowledge[]>();

    // 12. Generate AI reply
    const aiResult = await generateGymReply({
      gym,
      gymKnowledge: knowledge ?? [],
      lead,
      conversationHistory: history ?? [],
      incomingMessage: incoming.text,
    });

    // 13. Send reply via WhatsApp
    let replyStatus: 'sent' | 'failed' = 'failed';
    let replyMsgId: string | undefined;

    if (gym.phone_number_id && gym.whatsapp_token) {
      const sendResult = await sendWhatsAppMessage(
        gym.phone_number_id,
        gym.whatsapp_token,
        incoming.from,
        aiResult.reply
      );
      replyStatus = sendResult.success ? 'sent' : 'failed';
      replyMsgId = sendResult.messageId;
    }

    // 14. Save outgoing message
    await supabase.from('messages').insert({
      conversation_id: conversation.id,
      gym_id: gym.id,
      wa_message_id: replyMsgId,
      direction: 'outbound',
      sender: 'ai',
      content: aiResult.reply,
      status: replyStatus,
      ai_confidence: aiResult.confidence,
      tokens_used: aiResult.tokensUsed,
    });

    // 15. Update lead with AI classification
    const leadUpdate: Partial<Lead> = {
      ...aiResult.leadUpdate,
      updated_at: new Date().toISOString(),
    };

    if (lead.status === 'new') {
      leadUpdate.status = aiResult.leadUpdate.status ?? 'contacted';
    }

    // Merge interest arrays rather than replacing them
    if (aiResult.leadUpdate.interests?.length) {
      const combined = [...new Set([...lead.interests, ...aiResult.leadUpdate.interests])];
      leadUpdate.interests = combined;
    }

    await supabase.from('leads').update(leadUpdate).eq('id', lead.id);

    // Update conversation metadata
    await supabase
      .from('conversations')
      .update({
        last_message_at: new Date().toISOString(),
        message_count: (conversation.message_count ?? 0) + 2,
      })
      .eq('id', conversation.id);

    // 16. Schedule follow-up if AI recommends it
    if (aiResult.scheduleFollowUp) {
      const scheduledAt = new Date(
        Date.now() + aiResult.followUpDelay * 60 * 60 * 1000
      ).toISOString();

      const followUpTypeMap: Record<number, string> = {
        24:  'day1_followup',
        72:  'day3_followup',
        168: 'day7_followup',
      };

      await supabase.from('follow_ups').insert({
        gym_id: gym.id,
        lead_id: lead.id,
        conversation_id: conversation.id,
        type: followUpTypeMap[aiResult.followUpDelay] ?? 'custom',
        message_template: `Follow-up for ${incoming.senderName || incoming.from}`,
        scheduled_at: scheduledAt,
        status: 'pending',
      });
    }

    // 17. Notify gym owner if lead just became hot or converted
    const updatedStatus = leadUpdate.status ?? lead.status;
    if (['hot', 'converted'].includes(updatedStatus)) {
      const summaryTitle =
        updatedStatus === 'converted'
          ? `🎉 New Member: ${incoming.senderName || incoming.from}`
          : `🔥 Hot Lead: ${incoming.senderName || incoming.from}`;

      const summaryContent =
        updatedStatus === 'converted'
          ? `A new member just joined via WhatsApp! Phone: ${incoming.from}. Interests: ${(leadUpdate.interests ?? lead.interests).join(', ')}.`
          : `A lead from ${incoming.from} is showing strong buying signals. Score: ${leadUpdate.score ?? lead.score}/100. Plan interest: ${leadUpdate.interested_plan ?? lead.interested_plan ?? 'Not specified'}.`;

      await supabase.from('ai_summaries').insert({
        gym_id: gym.id,
        lead_id: lead.id,
        type: updatedStatus === 'converted' ? 'conversion_alert' : 'lead_summary',
        title: summaryTitle,
        content: summaryContent,
        sent_via: [],
      });
    }

    return NextResponse.json({ status: 'processed' });
  } catch (err) {
    console.error('[Webhook] Processing error:', err);
    // Always return 200 to Meta to prevent exponential retry storms
    return NextResponse.json({ status: 'error', message: String(err) }, { status: 200 });
  }
}
