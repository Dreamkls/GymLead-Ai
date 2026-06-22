// src/app/api/cron/follow-ups/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// Cron Job: Process pending follow-ups (runs every hour via vercel.json)
//
// IMPORTANT — WhatsApp 24-hour window policy:
//   day1_followup  (24h)  → sendWhatsAppMessage (free-form, within window)
//   day3_followup  (72h)  → must use sendWhatsAppTemplate (pre-approved template)
//   day7_followup  (168h) → must use sendWhatsAppTemplate (pre-approved template)
//
// Currently all three use sendWhatsAppMessage. Before going live, register
// approved templates in Meta Business Manager and switch day3/day7 to
// sendWhatsAppTemplate to avoid policy violations.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { generateFollowUpMessage } from '@/lib/ai/openrouter';
import { sendWhatsAppMessage } from '@/lib/whatsapp/client';
import type { FollowUp, Lead, Gym } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // Verify cron secret — must match CRON_SECRET env var (set in Vercel dashboard)
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();
  const now = new Date().toISOString();

  // Fetch all pending follow-ups that are due
  const { data: followUps, error } = await supabase
    .from('follow_ups')
    .select(
      `
      *,
      leads!inner(*),
      gyms!inner(*)
    `
    )
    .eq('status', 'pending')
    .lte('scheduled_at', now)
    .lt('attempt_count', 3)
    .limit(50) // Max 50 per hourly run to stay within Vercel function timeouts
    .returns<Array<FollowUp & { leads: Lead; gyms: Gym }>>();

  if (error) {
    console.error('[Cron:follow-ups] Failed to fetch follow-ups:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let sent = 0;
  let failed = 0;

  for (const followUp of followUps ?? []) {
    const lead = followUp.leads;
    const gym = followUp.gyms;

    // Skip if lead is already converted or lost
    if (['converted', 'lost'].includes(lead.status)) {
      await supabase
        .from('follow_ups')
        .update({ status: 'cancelled' })
        .eq('id', followUp.id);
      continue;
    }

    // Generate personalised message
    let message: string;
    try {
      message = await generateFollowUpMessage(lead, followUp.type, {
        name: gym.name,
        phone: gym.phone_number,
      });
    } catch {
      message = followUp.message_template; // Fall back to stored template
    }

    // Require WhatsApp credentials
    if (!gym.phone_number_id || !gym.whatsapp_token) {
      await supabase
        .from('follow_ups')
        .update({ status: 'failed', error_message: 'Gym WhatsApp not configured' })
        .eq('id', followUp.id);
      failed++;
      continue;
    }

    const result = await sendWhatsAppMessage(
      gym.phone_number_id,
      gym.whatsapp_token,
      lead.phone,
      message
    );

    if (result.success) {
      // Mark follow-up as sent
      await supabase
        .from('follow_ups')
        .update({ status: 'sent', sent_at: now })
        .eq('id', followUp.id);

      // Save to conversation messages
      if (followUp.conversation_id) {
        await supabase.from('messages').insert({
          conversation_id: followUp.conversation_id,
          gym_id: gym.id,
          wa_message_id: result.messageId,
          direction: 'outbound',
          sender: 'ai',
          content: message,
          status: 'sent',
        });
      }

      // Log activity
      await supabase.from('lead_activities').insert({
        gym_id: gym.id,
        lead_id: lead.id,
        type: 'follow_up_sent',
        description: `Automated ${followUp.type.replace(/_/g, ' ')} sent`,
        actor: 'ai',
      });

      sent++;
    } else {
      const attemptCount = (followUp.attempt_count ?? 0) + 1;
      const isFinal = attemptCount >= 3;

      await supabase
        .from('follow_ups')
        .update({
          attempt_count: attemptCount,
          error_message: result.error,
          // Reschedule 1 hour later for non-final attempts
          ...(isFinal
            ? { status: 'failed' }
            : {
                status: 'pending',
                scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
              }),
        })
        .eq('id', followUp.id);

      failed++;
    }
  }

  return NextResponse.json({
    processed: (followUps ?? []).length,
    sent,
    failed,
    timestamp: now,
  });
}
