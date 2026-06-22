// src/app/api/dashboard/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import type { DashboardStats, LeadFunnelData, ConversionTrendData } from '@/types';

export async function GET() {
  const supabase = await createClient();

  // Auth guard
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Resolve gym(s) for this owner
  const { data: gyms } = await supabase
    .from('gyms')
    .select('id')
    .eq('owner_id', user.id);

  if (!gyms?.length) {
    return NextResponse.json({ error: 'No gym found' }, { status: 404 });
  }

  const gymId = gyms[0].id;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  ).toISOString();
  const in30Days = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  // Parallel queries for performance
  const [
    { count: totalLeads },
    { count: newLeadsToday },
    { count: hotLeads },
    { count: convertedMonth },
    { count: renewalsDue },
    { count: pendingFollowUps },
    { count: activeConversations },
    { data: leadsForFunnel },
    { data: conversionsLast30 },
    { data: revenueData },
    { data: scoreData },
  ] = await Promise.all([
    supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .eq('gym_id', gymId),
    supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .eq('gym_id', gymId)
      .gte('created_at', startOfToday),
    supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .eq('gym_id', gymId)
      .eq('status', 'hot'),
    supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .eq('gym_id', gymId)
      .eq('status', 'converted')
      .gte('converted_at', startOfMonth),
    supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .eq('gym_id', gymId)
      .eq('status', 'renewal_due')
      .lte('membership_end', in30Days),
    supabase
      .from('follow_ups')
      .select('*', { count: 'exact', head: true })
      .eq('gym_id', gymId)
      .eq('status', 'pending'),
    supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('gym_id', gymId)
      .eq('status', 'active'),
    supabase.from('leads').select('status').eq('gym_id', gymId),
    supabase
      .from('leads')
      .select('created_at, converted_at, status')
      .eq('gym_id', gymId)
      .gte('created_at', new Date(Date.now() - 30 * 86_400_000).toISOString()),
    supabase
      .from('leads')
      .select('monthly_fee')
      .eq('gym_id', gymId)
      .eq('status', 'converted')
      .gte('converted_at', startOfMonth),
    // Fetch all lead scores to compute real average
    supabase.from('leads').select('score').eq('gym_id', gymId),
  ]);

  // Conversion rate
  const conversionRate = totalLeads
    ? Math.round(((convertedMonth ?? 0) / totalLeads) * 100)
    : 0;

  // Revenue this month
  const revenueThisMonth = (revenueData ?? []).reduce(
    (sum, r) => sum + (r.monthly_fee ?? 0),
    0
  );

  // Correct average lead score — uses actual score values, not a status-weighted approximation
  const scores = (scoreData ?? []).map((r) => r.score as number).filter((s) => s != null);
  const avgLeadScore =
    scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 0;

  const stats: DashboardStats = {
    totalLeads: totalLeads ?? 0,
    newLeadsToday: newLeadsToday ?? 0,
    hotLeads: hotLeads ?? 0,
    convertedThisMonth: convertedMonth ?? 0,
    conversionRate,
    renewalsDue: renewalsDue ?? 0,
    pendingFollowUps: pendingFollowUps ?? 0,
    activeConversations: activeConversations ?? 0,
    revenueThisMonth,
    avgLeadScore,
  };

  // Build funnel
  const statusCounts: Record<string, number> = {};
  for (const lead of leadsForFunnel ?? []) {
    statusCounts[lead.status] = (statusCounts[lead.status] ?? 0) + 1;
  }
  const total = totalLeads ?? 1;

  const funnel: LeadFunnelData[] = [
    {
      stage: 'New',
      count: statusCounts.new ?? 0,
      percentage: Math.round(((statusCounts.new ?? 0) / total) * 100),
      color: '#6366F1',
    },
    {
      stage: 'Contacted',
      count: statusCounts.contacted ?? 0,
      percentage: Math.round(((statusCounts.contacted ?? 0) / total) * 100),
      color: '#8B5CF6',
    },
    {
      stage: 'Warm',
      count: (statusCounts.warm ?? 0) + (statusCounts.qualified ?? 0),
      percentage: Math.round(
        (((statusCounts.warm ?? 0) + (statusCounts.qualified ?? 0)) / total) * 100
      ),
      color: '#F59E0B',
    },
    {
      stage: 'Hot',
      count: statusCounts.hot ?? 0,
      percentage: Math.round(((statusCounts.hot ?? 0) / total) * 100),
      color: '#EF4444',
    },
    {
      stage: 'Converted',
      count: statusCounts.converted ?? 0,
      percentage: Math.round(((statusCounts.converted ?? 0) / total) * 100),
      color: '#10B981',
    },
  ];

  // Build 30-day trend
  const trendMap: Record<string, { leads: number; conversions: number }> = {};
  for (const lead of conversionsLast30 ?? []) {
    const date = lead.created_at.slice(0, 10);
    if (!trendMap[date]) trendMap[date] = { leads: 0, conversions: 0 };
    trendMap[date].leads++;
    if (lead.status === 'converted') trendMap[date].conversions++;
  }

  const trend: ConversionTrendData[] = Object.entries(trendMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, data]) => ({ date, ...data }));

  return NextResponse.json({ stats, funnel, trend, gymId });
}
