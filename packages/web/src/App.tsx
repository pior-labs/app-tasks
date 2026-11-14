import { useCallback, useEffect, useState } from 'react';
import { Tasks } from './Tasks';

type User = { name: string; email: string };
export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(new URLSearchParams(location.search).has('error') ? 'Sign-in could not be completed. Please try again.' : '');
  useEffect(() => {
    fetch('/api/me').then(async (response) => {
      if (response.status === 401) return;
      if (!response.ok) throw new Error();
      setUser((await response.json()).user);
    }).catch(() => setError('Unable to connect. Please reload to try again.')).finally(() => setLoading(false));
  }, []);
  // A task request answered with 401 means the session ended: show the signed-out view.
  const handleSignedOut = useCallback(() => {
    setUser(null);
    setError('Your session has ended. Please sign in again.');
  }, []);
  async function authenticate() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(user ? '/api/auth/sign-out' : '/api/auth/sign-in/oauth2', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(user ? {} : { providerId: 'auth-pior', callbackURL: '/', errorCallbackURL: '/?error=sign-in' }),
      });
      if (!response.ok) throw new Error();
      // An explicit sign-out is not an ended session, even if a task request got a 401 meanwhile.
      if (user) { setUser(null); setError(''); }
      else {
        const { url } = await response.json();
        location.assign(url);
      }
    } catch { setError('Something went wrong. Please try again.'); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto flex min-h-screen max-w-3xl items-center px-6 py-16">
    <section className="w-full space-y-6">
      <p className="text-sm font-medium uppercase tracking-[0.2em] opacity-60">Pior Labs</p>
      <h1 className="text-5xl font-semibold tracking-tight">Tasks</h1>
      {loading ? <p role="status">Loading your session...</p> : <>
        <p className="text-lg opacity-75">{user ? `Welcome, ${user.name}.` : 'A little space for what comes next.'}</p>
        {user && <div className="rounded-lg border p-5"><p className="font-medium">Signed in as {user.name}</p><p className="mt-1 opacity-65">{user.email}</p></div>}
        {user && <Tasks onSignedOut={handleSignedOut} />}
        <button disabled={busy} onClick={() => void authenticate()} className="rounded-md bg-primary px-5 py-3 font-medium text-primary-foreground disabled:opacity-50">{busy ? 'Please wait...' : user ? 'Sign out' : 'Sign in with Pior Labs'}</button>
      </>}
      {error && <p role="alert">{error}</p>}
    </section>
  </main>;
}
