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

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  // Store Bearer session token strictly in memory (never localStorage/sessionStorage)
  const tokenRef = useRef<string | null>(null);
  const authModeRef = useRef<'session' | 'firebase' | null>(null);

  const getBearerToken = useCallback(async (): Promise<string | null> => {
    if (authModeRef.current === 'firebase' && auth.currentUser) {
      const fresh = await auth.currentUser.getIdToken();
      tokenRef.current = fresh;
      return fresh;
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
    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      // Only handle Firebase auth state if user didn't sign in via email/password session
      if (authModeRef.current === 'session' && tokenRef.current) {
        setLoading(false);
        return;
      }

      if (!fbUser) {
        if (authModeRef.current !== 'session') {
          tokenRef.current = null;
          authModeRef.current = null;
          setUser(null);
        }
        setLoading(false);
        return;
      }

      try {
        const idToken = await fbUser.getIdToken();
        tokenRef.current = idToken;
        authModeRef.current = 'firebase';

        const res = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setAuthError(data.error || 'Unable to verify account access.');
          await firebaseSignOut(auth);
          tokenRef.current = null;
          authModeRef.current = null;
          setUser(null);
        } else {
          setAuthError(null);
          setUser(data.user as AppUser);
        }
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : 'Authentication check failed');
        setUser(null);
      } finally {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  const loginWithEmail = useCallback(async (email: string, password: string): Promise<AppUser> => {
    setAuthError(null);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Invalid email or password.');
    }
    tokenRef.current = data.token;
    authModeRef.current = 'session';
    setUser(data.user as AppUser);
    return data.user as AppUser;
  }, []);

  const setupInitialAdmin = useCallback(
    async (name: string, email: string, password: string): Promise<AppUser> => {
      setAuthError(null);
      const res = await fetch('/api/auth/setup-admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Failed to configure initial administrator.');
      }
      tokenRef.current = data.token;
      authModeRef.current = 'session';
      setUser(data.user as AppUser);
      return data.user as AppUser;
    },
    []
  );

  const loginWithGoogle = useCallback(async (): Promise<AppUser> => {
    setAuthError(null);
    const cred = await signInWithPopup(auth, googleAuthProvider);
    const idToken = await cred.user.getIdToken();
    tokenRef.current = idToken;
    authModeRef.current = 'firebase';

    const res = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      await firebaseSignOut(auth);
      tokenRef.current = null;
      authModeRef.current = null;
      throw new Error(data.error || 'Account not authorized for this workspace.');
    }
    setUser(data.user as AppUser);
    return data.user as AppUser;
  }, []);

  const logout = useCallback(async () => {
    tokenRef.current = null;
    authModeRef.current = null;
    setUser(null);
    setAuthError(null);
    if (auth.currentUser) {
      await firebaseSignOut(auth);
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
