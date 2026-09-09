'use client';

import { FormEvent, useState } from 'react';

// Admin sign-in. POSTs the password to /api/admin/login, which sets the
// httpOnly session cookie; on success we hard-navigate so the middleware sees
// the cookie on the very next request.
export default function AdminLoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? `Грешка (${res.status})`);
        return;
      }
      // Only ever return to an admin path — never to an arbitrary URL.
      const next = new URLSearchParams(window.location.search).get('next') ?? '';
      window.location.assign(next.startsWith('/admin') ? next : '/admin');
    } catch {
      setError('Няма връзка със сървъра');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm bg-white rounded-2xl shadow-lg border border-gray-200 p-6 space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Администрация</h1>
          <p className="text-sm text-gray-500 mt-0.5">МУ-Плевен AI Library</p>
        </div>
        <label className="block">
          <span className="block text-xs font-medium text-gray-600 mb-1">Парола</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            required
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#7B1C1C] focus:border-transparent"
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full py-2 rounded-lg text-white text-sm font-semibold disabled:opacity-50"
          style={{ backgroundColor: '#7B1C1C' }}
        >
          {busy ? 'Влизане…' : 'Вход'}
        </button>
      </form>
    </div>
  );
}
