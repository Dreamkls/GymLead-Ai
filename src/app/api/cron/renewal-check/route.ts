// src/app/api/cron/renewal-check/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// Cron Job: Flag expiring memberships and schedule renewal follow-ups (9am UTC)
// Marks leads as renewal_due and inserts follow_ups if they haven't been sent
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import type { Lead } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Remind members whose membership expires within this many days
const RENEWAL_WINDOW_DAYS = 7;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();
  const now = new Date();
  const windowEnd = new Date(now.getTime() + RENEWAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const nowISO = now.toISOString();
  const windowEndISO = windowEnd.toISOString().slice(0, 10); // DATE comparison

  // Find converted members whose membership ends within the window
  const { data: expiringLeads, error } = await supabase
    .from('leads')
    .select('*')
    .eq('status', 'converted')
    .lte('membership_end', windowEndISO)
    .gte('membership_end', now.toISOString().slice(0, 10)) // Not already expired
    .returns<Lead[]>();

  if (error) {
    console.error('[Cron:renewal-check] Query failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let flagged = 0;
  let alreadyScheduled = 0;
  let errored = 0;

  for (const lead of expiringLeads ?? []) {
    try {
      // Check if a renewal_reminder follow-up already exists for this lead
      const { data: existing } = await supabase
        .from('follow_ups')
        .select('id')
        .eq('lead_id', lead.id)
        .eq('type', 'renewal_reminder')
        .in('status', ['pending', 'sent'])
        .maybeSingle();

      if (existing) {
        alreadyScheduled++;
        continue;
      }

      // Mark lead as renewal_due
      await supabase
        .from('leads')
        .update({ status: 'renewal_due' })
        .eq('id', lead.id);

      // Find the most recent conversation for this lead
      const { data: conv } = await supabase
        .from('conversations')
        .select('id')
        .eq('lead_id', lead.id)
        .order('last_message_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      // Schedule renewal reminder immediately
      await supabase.from('follow_ups').insert({
        gym_id: lead.gym_id,
        lead_id: lead.id,
        conversation_id: conv?.id ?? null,
        type: 'renewal_reminder',
        message_template: `Hi ${lead.name ?? 'there'}! Your membership is expiring soon. Let's get it renewed!`,
        scheduled_at: nowISO,
        status: 'pending',
      });

      // Log activity
      await supabase.from('lead_activities').insert({
        gym_id: lead.gym_id,
        lead_id: lead.id,
        type: 'renewal_reminder_sent',
        description: `Membership expiring on ${lead.membership_end} — renewal reminder scheduled`,
        actor: 'system',
      });

      flagged++;
    } catch (err) {
      console.error(`[Cron:renewal-check] Error for lead ${lead.id}:`, err);
      errored++;
    }
  }

  return NextResponse.json({
    found: (expiringLeads ?? []).length,
    flagged,
    alreadyScheduled,
    errored,
    timestamp: nowISO,
  });
}
