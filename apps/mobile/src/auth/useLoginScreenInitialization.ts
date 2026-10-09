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
    // The exchange may already have advanced to a continuation requiring a ticket.
    // Mounting must not cancel either the browser wait or that continuation.
    const step = auth.loginState?.step;
    if (
      step === 'browser-redirect' ||
      step === 'account-selection' ||
      step === 'binding' ||
      step === 'sso-verification'
    ) return;
    void auth.dispatchLoginAction({ type: 'reset' });
  }, [additionalAccount, auth]);
}
