// src/lib/supabase/server.ts
// ─────────────────────────────────────────────────────────────────────────────
// Two Supabase clients:
//   createClient()        — cookie-based, respects RLS, for user-facing routes
//   createServiceClient() — service role, bypasses RLS, for API/cron routes only
// ─────────────────────────────────────────────────────────────────────────────

import { createServerClient } from '@supabase/ssr';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

/** Cookie-based client — honours Row Level Security. Use in Server Components and user-facing API routes. */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Silently ignored when called from a Server Component
          }
        },
      },
    }
  );
}

/**
 * Service-role client — bypasses RLS.
 * ONLY use in server-side API routes and cron jobs. Never import in client components.
 */
export function createServiceClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}
