import React, { useEffect, useState } from 'react';
import { AlertCircle, Factory, Lock, Mail, ShieldCheck } from 'lucide-react';
import { useAuth, AppUser } from '../context/AuthContext';

interface LoginScreenProps {
  onSignedIn: (user: AppUser) => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onSignedIn }) => {
  const { loginWithEmail, setupInitialAdmin, loginWithGoogle, authError, clearAuthError } =
    useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [setupMode, setSetupMode] = useState(false);
  const [setupName, setSetupName] = useState('System Administrator');
  const [needsInitialPassword, setNeedsInitialPassword] = useState(false);
  const [defaultAdminEmail, setDefaultAdminEmail] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 3000);
    fetch('/api/auth/setup-status', { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => {
        if (!mounted) return;
        setNeedsInitialPassword(Boolean(data.needsInitialPassword));
        if (data.defaultAdminEmail) {
          setDefaultAdminEmail(data.defaultAdminEmail);
        }
      })
      .catch(() => {
        // Ignore non-fatal status check failure
      })
      .finally(() => {
        window.clearTimeout(timer);
      });
    return () => {
      mounted = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    clearAuthError();

    if (!email.trim() || !password) {
      setError('Please enter both your email address and password.');
      return;
    }

    setSubmitting(true);
    try {
      const signedInUser = setupMode
        ? await setupInitialAdmin(setupName.trim(), email.trim(), password)
        : await loginWithEmail(email.trim(), password);
      onSignedIn(signedInUser);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    clearAuthError();
    setSubmitting(true);
    try {
      const signedInUser = await loginWithGoogle();
      onSignedIn(signedInUser);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed');
    } finally {
      setSubmitting(false);
    }
  };

  const displayError = error || authError;

  return (
    <div className="min-h-screen w-full font-sans bg-[#F8FAFC] flex flex-col justify-center items-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-slate-900 text-white mb-4 shadow-md">
            <Factory className="w-5 h-5 text-indigo-400" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Abone Cut Pieces Tracking
          </h1>
          <p className="text-sm text-slate-500 mt-1.5">
            Raw material ledger, batch traceability, and stage control
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl shadow-md p-6 sm:p-8">
          <div className="mb-6">
            <h2 className="text-lg font-bold tracking-tight text-slate-900">
              {setupMode ? 'Set Initial Administrator Password' : 'Sign in to workspace'}
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              {setupMode
                ? 'One-time setup to enable email and password sign-in for the primary administrator.'
                : 'Use your assigned operator, store keeper, manager, or admin credentials.'}
            </p>
          </div>

          {displayError && (
            <div className="mb-5 p-3 rounded-lg bg-red-50 border border-red-200 flex items-start gap-2.5 text-xs text-red-800">
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <span>{displayError}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {setupMode && (
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">
                  Administrator Name
                </label>
                <input
                  type="text"
                  value={setupName}
                  onChange={(e) => setSetupName(e.target.value)}
                  required
                  className="w-full px-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">
                Email Address
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                  autoComplete="email"
                  required
                  className="w-full pl-10 pr-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">
                {setupMode ? 'Create Password (min. 8 characters)' : 'Password'}
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  autoComplete={setupMode ? 'new-password' : 'current-password'}
                  required
                  minLength={setupMode ? 8 : 1}
                  className="w-full pl-10 pr-3.5 py-2.5 text-sm font-normal bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 px-4 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors shadow-sm"
            >
              {submitting
                ? 'Authenticating...'
                : setupMode
                ? 'Save Admin Password & Sign In'
                : 'Sign In'}
            </button>
          </form>

          <div className="my-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-slate-200" />
            <span className="text-xs text-slate-400">or</span>
            <div className="h-px flex-1 bg-slate-200" />
          </div>

          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={submitting}
            className="w-full py-2.5 px-4 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
              />
              <path
                fill="#34A853"
                d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
              />
              <path
                fill="#FBBC05"
                d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
              />
              <path
                fill="#EA4335"
                d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
              />
            </svg>
            <span>Continue with Google</span>
          </button>

          {needsInitialPassword && (
            <div className="mt-5 pt-4 border-t border-slate-200 flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-1.5 text-slate-600">
                <ShieldCheck className="w-4 h-4 text-slate-500 shrink-0" />
                <span>First-time admin setup</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  const next = !setupMode;
                  setSetupMode(next);
                  setError(null);
                  if (next && defaultAdminEmail && !email) {
                    setEmail(defaultAdminEmail);
                  }
                }}
                className="font-medium text-indigo-600 underline underline-offset-2 hover:text-indigo-700"
              >
                {setupMode ? 'Back to Sign In' : 'Claim Admin Password'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
