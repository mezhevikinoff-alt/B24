import React, { createContext, useContext, useEffect, useState } from 'react';
import type { BX24User } from '../types';
import { getCurrentUserFull, setBxAuthToken } from '../api/bitrix';
import '../bx24.d';

interface AppCtx {
  isReady: boolean;
  isAdmin: boolean;
  currentUser: BX24User | null;
  allUsers: BX24User[];
  setAllUsers: (u: BX24User[]) => void;
}

const Ctx = createContext<AppCtx>({
  isReady: false,
  isAdmin: false,
  currentUser: null,
  allUsers: [],
  setAllUsers: () => {},
});

function reportBx24Debug(info: Record<string, unknown>) {
  fetch('/api/bx24-debug', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(info),
  }).catch(() => {});
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [isReady, setIsReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [currentUser, setCurrentUser] = useState<BX24User | null>(null);
  const [allUsers, setAllUsers] = useState<BX24User[]>([]);

  useEffect(() => {
    let settled = false;

    const initApp = async (bxToken?: string) => {
      if (settled) return;
      settled = true;

      if (bxToken) {
        setBxAuthToken(bxToken);
        console.log('[AppContext] BX24 token acquired, len=' + bxToken.length);
      } else {
        console.log('[AppContext] No BX24 token — relying on Vibe headers / cookie');
      }

      try {
        const me = await fetch('/api/me').then((r) => r.json()) as {
          userId?: string;
          userName?: string;
          isAdmin?: boolean;
        };
        setIsAdmin(me.isAdmin === true);
        if (me.userId) {
          try {
            const full = await getCurrentUserFull(me.userId);
            if (full) setCurrentUser(full);
          } catch {
            // show app without full user info
          }
        }
      } catch {
        // show app even if /api/me fails
      }

      setIsReady(true);
    };

    if (window.BX24) {
      // Inside Bitrix24 iframe — wait for SDK handshake
      window.BX24.init(() => {
        const auth = window.BX24?.getAuth();
        reportBx24Debug({
          event: 'init_fired',
          hasAuth: !!auth,
          authKeys: auth ? Object.keys(auth) : null,
          hasToken: !!(auth?.access_token),
          tokenLen: auth?.access_token?.length ?? 0,
          domain: auth?.domain ?? null,
        });
        initApp(auth?.access_token ?? undefined);
      });

      // Safety fallback: if BX24.init never fires (direct browser access), proceed after 5s
      const timer = setTimeout(() => {
        if (!settled) {
          reportBx24Debug({
            event: 'timeout_fired',
            hasBX24: !!window.BX24,
            settled,
          });
          initApp();
        }
      }, 5000);
      return () => clearTimeout(timer);
    } else {
      // Not in Bitrix24 — proceed immediately (dev / healthcheck access)
      reportBx24Debug({ event: 'no_bx24_object' });
      initApp();
    }
  }, []);

  return (
    <Ctx.Provider value={{ isReady, isAdmin, currentUser, allUsers, setAllUsers }}>
      {children}
    </Ctx.Provider>
  );
}

export function useApp() {
  return useContext(Ctx);
}
