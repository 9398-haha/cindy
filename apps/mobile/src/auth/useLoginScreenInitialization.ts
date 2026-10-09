import { useEffect, useRef } from 'react';
import type { AuthContextValue } from './AuthContext';

export function useLoginScreenInitialization(auth: AuthContextValue, additionalAccount: boolean) {
  const initializedLoginRef = useRef(false);
  useEffect(() => {
    if (
      !auth.initialized ||
      (!additionalAccount && auth.isAuthenticated) ||
      initializedLoginRef.current
    )
      return;
    initializedLoginRef.current = true;
    // Deep-link navigation can remount this screen while AuthProvider survives.
    // Mounting is not a user cancellation of the pending browser authorization.
    if (auth.loginState?.step === 'browser-redirect') return;
    void auth.dispatchLoginAction({ type: 'reset' });
  }, [additionalAccount, auth]);
}
