// src/app/api/leads/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { classifyLead, generateLeadSummary } from '@/lib/ai/openrouter';
import type { Lead } from '@/types';

// ─── GET /api/leads?page=1&limit=20&status=hot&search=john ───────────────────
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const page = parseInt(searchParams.get('page') ?? '1');
  const limit = parseInt(searchParams.get('limit') ?? '20');
  const status = searchParams.get('status');
  const search = searchParams.get('search');
  const gymId = searchParams.get('gym_id');

  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from('leads')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (gymId) query = query.eq('gym_id', gymId);
  if (status) query = query.eq('status', status);
  if (search) {
    query = query.or(
      `name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`
    );
  }

  const { data: leads, count, error } = await query.returns<Lead[]>();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    leads,
    pagination: {
      page,
      limit,
      total: count ?? 0,
      pages: Math.ceil((count ?? 0) / limit),
    },
  });
}

// ─── POST /api/leads — manually add a lead ───────────────────────────────────
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { data: lead, error } = await supabase
    .from('leads')
    .insert({ ...body, source: body.source ?? 'manual' })
    .select()
    .single<Lead>();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await supabase.from('lead_activities').insert({
    gym_id: lead.gym_id,
    lead_id: lead.id,
    type: 'created',
    description: 'Lead manually added',
    actor: 'human',
  });

  return NextResponse.json({ lead }, { status: 201 });
}

// ─── PATCH /api/leads?id=xxx ─────────────────────────────────────────────────
export async function PATCH(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const body = await req.json();

  // ── Action: AI re-classify ────────────────────────────────────────────────
  if (body.action === 'classify') {
    const { data: lead } = await supabase
      .from('leads')
      .select('*')
      .eq('id', id)
      .single<Lead>();
    if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 });

    // Only fetch messages belonging to this specific lead's conversations
    const { data: messages } = await supabase
      .from('messages')
      .select('content, conversation_id')
      .eq('gym_id', lead.gym_id)
      .in(
        'conversation_id',
        (
          await supabase
            .from('conversations')
            .select('id')
            .eq('lead_id', lead.id)
        ).data?.map((c) => c.id) ?? []
      )
      .order('created_at', { ascending: false })
      .limit(10);

    const msgTexts = (messages ?? []).map((m) => m.content);
    const classification = await classifyLead(lead, msgTexts);

    const { data: updated } = await supabase
      .from('leads')
      .update({
        status: classification.status,
        score: classification.score,
        ai_tags: classification.tags,
        last_ai_analysis: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single<Lead>();

    await supabase.from('lead_activities').insert({
      gym_id: lead.gym_id,
      lead_id: lead.id,
      type: 'score_updated',
      description: `AI re-classified: ${classification.status} (score: ${classification.score})`,
      old_value: `${lead.status}/${lead.score}`,
      new_value: `${classification.status}/${classification.score}`,
      actor: 'ai',
    });

    return NextResponse.json({ lead: updated });
  }

  // ── Action: AI summarize ─────────────────────────────────────────────────
  if (body.action === 'summarize') {
    const { data: lead } = await supabase
      .from('leads')
      .select('*')
      .eq('id', id)
      .single<Lead>();
    if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 });

    const { data: gym } = await supabase
      .from('gyms')
      .select('*')
      .eq('id', lead.gym_id)
      .single();

    // FIX: filter messages by lead_id through conversations, not just gym_id.
    // The original code fetched all messages for the entire gym, causing the AI
    // to summarise conversations belonging to other leads.
    const { data: convRows } = await supabase
      .from('conversations')
      .select('id')
      .eq('lead_id', lead.id);

    const convIds = (convRows ?? []).map((c) => c.id);

    const { data: messages } =
      convIds.length > 0
        ? await supabase
            .from('messages')
            .select('*')
            .in('conversation_id', convIds)
            .order('created_at', { ascending: false })
            .limit(20)
        : { data: [] };

    const { data: activities } = await supabase
      .from('lead_activities')
      .select('*')
      .eq('lead_id', lead.id)
      .order('created_at', { ascending: false })
      .limit(15);

    const summary = await generateLeadSummary({
      lead,
      messages: messages ?? [],
      activities: activities ?? [],
      gym,
    });

    await supabase
      .from('leads')
      .update({ ai_summary: summary, last_ai_analysis: new Date().toISOString() })
      .eq('id', id);

    await supabase.from('ai_summaries').insert({
      gym_id: lead.gym_id,
      lead_id: lead.id,
      type: 'lead_summary',
      title: `Summary: ${lead.name ?? lead.phone}`,
      content: summary,
      sent_via: [],
    });

    return NextResponse.json({ summary });
  }

  // ── Regular field update ─────────────────────────────────────────────────
  const { data: updated, error } = await supabase
    .from('leads')
    .update(body)
    .eq('id', id)
    .select()
    .single<Lead>();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ lead: updated });
}
