// src/app/(dashboard)/page.tsx
// Minimal scaffold — Phase 2 will add the full dashboard UI.

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">GymLead AI Dashboard</h1>
        <p className="text-gray-500 mb-6">Logged in as {user.email}</p>
        <p className="text-sm text-amber-600 bg-amber-50 rounded-lg px-4 py-3 inline-block">
          Full dashboard UI coming in Phase 2.
        </p>
      </div>
    </main>
  );
}
