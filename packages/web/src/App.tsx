import { useCallback, useEffect, useState } from 'react';
import { ThemeProvider } from '@pior-labs/design-system';
import { SignIn } from './SignIn';
import { Tasks } from './Tasks';

type User = { id: string | number; name: string; email: string };
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
      const response = await fetch(user ? '/api/auth/sign-out' : '/api/auth/sign-in/social', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(user ? {} : { provider: 'auth-pior', callbackURL: '/', errorCallbackURL: '/?error=sign-in' }),
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
  // The theme is chosen on the sign-in screen and in the account menu alike.
  return <ThemeProvider>{loading || !user ? (
    <SignIn loading={loading} busy={busy} error={error} onSignIn={() => void authenticate()} />
  ) : (
    <Tasks
      me={Number(user.id)}
      account={{ name: user.name, email: user.email }}
      signingOut={busy}
      accountError={error}
      onSignOut={() => void authenticate()}
      onSignedOut={handleSignedOut}
    />
  )}</ThemeProvider>;
}
