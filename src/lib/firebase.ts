import { initializeApp, getApps } from 'firebase/app';
import { getAuth, GoogleAuthProvider, type Auth } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

let auth: Auth | null = null;
let googleAuthProvider: GoogleAuthProvider | null = null;

try {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  auth = getAuth(app);
  googleAuthProvider = new GoogleAuthProvider();
} catch (err) {
  console.warn('Firebase client initialization skipped:', err);
  auth = null;
  googleAuthProvider = null;
}

export { auth, googleAuthProvider };

