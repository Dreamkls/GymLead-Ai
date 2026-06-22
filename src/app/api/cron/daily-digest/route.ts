// src/app/api/cron/daily-digest/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// Cron Job: Send daily AI digest to every active gym owner (runs 8am UTC)
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { generateDailyDigest } from '@/lib/ai/openrouter';
import type { Gym } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayISO = startOfToday.toISOString();
  const now = new Date().toISOString();

  // Fetch all active gyms
  const { data: gyms, error } = await supabase
    .from('gyms')
    .select('*')
    .eq('is_active', true)
    .returns<Gym[]>();

  if (error) {
    console.error('[Cron:daily-digest] Failed to fetch gyms:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let processed = 0;
  let errored = 0;

  for (const gym of gyms ?? []) {
    try {
      // Gather stats for this gym
      const [
        { count: newLeads },
        { count: hotLeads },
        { count: converted },
        { count: pendingFollowUps },
        { count: renewalsDue },
        { data: interestData },
      ] = await Promise.all([
        supabase
          .from('leads')
          .select('*', { count: 'exact', head: true })
          .eq('gym_id', gym.id)
          .gte('created_at', todayISO),
        supabase
          .from('leads')
          .select('*', { count: 'exact', head: true })
          .eq('gym_id', gym.id)
          .eq('status', 'hot'),
        supabase
          .from('leads')
          .select('*', { count: 'exact', head: true })
          .eq('gym_id', gym.id)
          .eq('status', 'converted')
          .gte('converted_at', todayISO),
        supabase
          .from('follow_ups')
          .select('*', { count: 'exact', head: true })
          .eq('gym_id', gym.id)
          .eq('status', 'pending'),
        supabase
          .from('leads')
          .select('*', { count: 'exact', head: true })
          .eq('gym_id', gym.id)
          .eq('status', 'renewal_due'),
        // Pull interests from today's new leads
        supabase
          .from('leads')
          .select('interests')
          .eq('gym_id', gym.id)
          .gte('created_at', todayISO),
      ]);

      // Tally top interests
      const interestCount: Record<string, number> = {};
      for (const lead of interestData ?? []) {
        for (const interest of lead.interests ?? []) {
          interestCount[interest] = (interestCount[interest] ?? 0) + 1;
        }
      }
      const topInterests = Object.entries(interestCount)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([interest]) => interest);

      const digest = await generateDailyDigest({
        gymName: gym.name,
        newLeads: newLeads ?? 0,
        hotLeads: hotLeads ?? 0,
        converted: converted ?? 0,
        pendingFollowUps: pendingFollowUps ?? 0,
        renewalsDue: renewalsDue ?? 0,
        topInterests,
      });

      // Save digest as an ai_summary record (future: also send via WhatsApp/email)
      await supabase.from('ai_summaries').insert({
        gym_id: gym.id,
        lead_id: null,
        type: 'daily_digest',
        title: `Daily Digest — ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`,
        content: digest,
        sent_via: [],
      });

      processed++;
    } catch (err) {
      console.error(`[Cron:daily-digest] Error for gym ${gym.id}:`, err);
      errored++;
    }
  }

  return NextResponse.json({ processed, errored, timestamp: now });
}
