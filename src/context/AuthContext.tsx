import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut as firebaseSignOut } from 'firebase/auth';
import { auth, googleAuthProvider } from '../lib/firebase';
import { UserRole } from '../lib/roles';

export interface AppUser {
  id: number;
  uid: string | null;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
}

interface AuthContextValue {
  user: AppUser | null;
  loading: boolean;
  authError: string | null;
  clearAuthError: () => void;
  loginWithEmail: (email: string, password: string) => Promise<AppUser>;
  setupInitialAdmin: (name: string, email: string, password: string) => Promise<AppUser>;
  loginWithGoogle: () => Promise<AppUser>;
  logout: () => Promise<void>;
  apiFetch: <T = unknown>(url: string, init?: RequestInit) => Promise<T>;
  downloadFile: (url: string, fallbackFilename: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (val) => {
        window.clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(() => Boolean(auth));
  const [authError, setAuthError] = useState<string | null>(null);

  // Store Bearer session token strictly in memory (never localStorage/sessionStorage)
  const tokenRef = useRef<string | null>(null);
  const authModeRef = useRef<'session' | 'firebase' | null>(null);
  const googlePopupActiveRef = useRef(false);

  const getBearerToken = useCallback(async (): Promise<string | null> => {
    if (authModeRef.current === 'session') {
      return tokenRef.current;
    }
    if (authModeRef.current === 'firebase' && auth?.currentUser) {
      try {
        const fresh = await withTimeout(
          auth.currentUser.getIdToken(),
          5000,
          'Session token refresh timed out'
        );
        tokenRef.current = fresh;
        return fresh;
      } catch {
        return tokenRef.current;
      }
    }
    return tokenRef.current;
  }, []);

  const apiFetch = useCallback(
    async <T = unknown>(url: string, init: RequestInit = {}): Promise<T> => {
      const token = await getBearerToken();
      const headers = new Headers(init.headers);
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      if (init.body && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }

      const res = await fetch(url, { ...init, headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      return data as T;
    },
    [getBearerToken]
  );

  const downloadFile = useCallback(
    async (url: string, fallbackFilename: string) => {
      const token = await getBearerToken();
      const headers = new Headers();
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Export failed (${res.status})`);
      }

      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="?([^"]+)"?/i);
      const filename = match?.[1] || fallbackFilename;

      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    },
    [getBearerToken]
  );

  useEffect(() => {
    let active = true;

    if (!auth) {
      setLoading(false);
      return;
    }

    // Fail-safe: never hang on the loading screen if Firebase Auth stalls in a new tab/browser
    const safetyTimer = window.setTimeout(() => {
      if (active) {
        setLoading(false);
      }
    }, 1800);

    let unsubscribe: () => void = () => {};
    const isSessionAuth = () => authModeRef.current === 'session';

    try {
      const fbAuth = auth;
      unsubscribe = onAuthStateChanged(
        fbAuth,
        async (fbUser) => {
          if (!active) return;

          // Let active Google popup login handle verification & error reporting directly
          if (googlePopupActiveRef.current) {
            return;
          }

          // Email/password sessions bypass Firebase OAuth checks completely
          if (isSessionAuth() && tokenRef.current) {
            window.clearTimeout(safetyTimer);
            setLoading(false);
            return;
          }

          if (!fbUser) {
            window.clearTimeout(safetyTimer);
            if (!isSessionAuth()) {
              tokenRef.current = null;
              authModeRef.current = null;
              setUser(null);
            }
            setLoading(false);
            return;
          }

          try {
            const idToken = await withTimeout(
              fbUser.getIdToken(),
              4000,
              'Google authentication token timed out'
            );

            // Re-check in case user signed in via email/password while getIdToken was pending
            if (!active || isSessionAuth()) {
              return;
            }

            const res = await fetchWithTimeout(
              '/api/auth/me',
              { headers: { Authorization: `Bearer ${idToken}` } },
              5000
            );

            if (!active || isSessionAuth()) {
              return;
            }

            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              await firebaseSignOut(fbAuth).catch(() => {});
              tokenRef.current = null;
              authModeRef.current = null;
              setUser(null);
              // Only show account access error if account is explicitly unauthorized/deactivated;
              // expired/stale Google tokens silently return user to the login form
              if (res.status === 403 && data.error) {
                setAuthError(data.error);
              }
            } else {
              tokenRef.current = idToken;
              authModeRef.current = 'firebase';
              setAuthError(null);
              setUser(data.user as AppUser);
            }
          } catch {
            if (!active || isSessionAuth()) {
              return;
            }
            await firebaseSignOut(fbAuth).catch(() => {});
            tokenRef.current = null;
            authModeRef.current = null;
            setUser(null);
          } finally {
            window.clearTimeout(safetyTimer);
            if (active) {
              setLoading(false);
            }
          }
        },
        () => {
          window.clearTimeout(safetyTimer);
          if (active && !isSessionAuth()) {
            tokenRef.current = null;
            authModeRef.current = null;
            setUser(null);
            setLoading(false);
          }
        }
      );
    } catch {
      window.clearTimeout(safetyTimer);
      setLoading(false);
    }

    return () => {
      active = false;
      window.clearTimeout(safetyTimer);
      unsubscribe();
    };
  }, []);

  const loginWithEmail = useCallback(async (email: string, password: string): Promise<AppUser> => {
    setAuthError(null);
    const res = await fetchWithTimeout(
      '/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      },
      10000
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Invalid email or password.');
    }
    tokenRef.current = data.token;
    authModeRef.current = 'session';
    setLoading(false);
    setUser(data.user as AppUser);
    return data.user as AppUser;
  }, []);

  const setupInitialAdmin = useCallback(
    async (name: string, email: string, password: string): Promise<AppUser> => {
      setAuthError(null);
      const res = await fetchWithTimeout(
        '/api/auth/setup-admin',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, password }),
        },
        10000
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Failed to configure initial administrator.');
      }
      tokenRef.current = data.token;
      authModeRef.current = 'session';
      setLoading(false);
      setUser(data.user as AppUser);
      return data.user as AppUser;
    },
    []
  );

  const loginWithGoogle = useCallback(async (): Promise<AppUser> => {
    setAuthError(null);
    if (!auth || !googleAuthProvider) {
      throw new Error('Google Sign-In is unavailable in this browser. Please sign in with Email and Password.');
    }

    googlePopupActiveRef.current = true;
    try {
      const cred = await signInWithPopup(auth, googleAuthProvider);
      const idToken = await withTimeout(
        cred.user.getIdToken(),
        6000,
        'Failed to obtain Google authentication token.'
      );

      const res = await fetchWithTimeout(
        '/api/auth/me',
        { headers: { Authorization: `Bearer ${idToken}` } },
        8000
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        await firebaseSignOut(auth).catch(() => {});
        tokenRef.current = null;
        authModeRef.current = null;
        setUser(null);
        throw new Error(data.error || 'Access Denied: Unauthorized Email');
      }

      tokenRef.current = idToken;
      authModeRef.current = 'firebase';
      setLoading(false);
      setUser(data.user as AppUser);
      return data.user as AppUser;
    } finally {
      googlePopupActiveRef.current = false;
    }
  }, []);

  const logout = useCallback(async () => {
    tokenRef.current = null;
    authModeRef.current = null;
    setUser(null);
    setAuthError(null);
    setLoading(false);
    try {
      if (auth?.currentUser) {
        await firebaseSignOut(auth);
      }
    } catch {
      // Ignore Firebase sign-out errors
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        authError,
        clearAuthError: () => setAuthError(null),
        loginWithEmail,
        setupInitialAdmin,
        loginWithGoogle,
        logout,
        apiFetch,
        downloadFile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}
