// src/middleware.ts
// ─────────────────────────────────────────────────────────────────────────────
// Route protection using Supabase session cookies.
//
// Protected:  /dashboard and any sub-routes
// Public:     /login, /register, /api/whatsapp/webhook (Meta requires no auth),
//             /api/cron/* (protected by CRON_SECRET header instead)
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: req });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value));
          res = NextResponse.next({ request: req });
          cookiesToSet.forEach(({ name, value, options }) =>
            res.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh session if expired — required for Server Components
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = req.nextUrl;

  // Redirect unauthenticated users away from dashboard routes
  if (pathname.startsWith('/dashboard') && !user) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('redirectTo', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Redirect authenticated users away from auth pages
  if ((pathname === '/login' || pathname === '/register') && user) {
    const dashboardUrl = req.nextUrl.clone();
    dashboardUrl.pathname = '/dashboard';
    return NextResponse.redirect(dashboardUrl);
  }

  return res;
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     *   - _next/static  (static files)
     *   - _next/image   (image optimisation)
     *   - favicon.ico
     *   - /api/whatsapp/webhook (Meta webhook, no session cookie)
     *   - /api/cron/*          (protected by CRON_SECRET header)
     */
    '/((?!_next/static|_next/image|favicon.ico|api/whatsapp/webhook|api/cron).*)',
  ],
};
