import React, { createContext, useContext, useEffect, useState } from 'react';
import type { BX24User } from '../types';
import { getCurrentUserFull } from '../api/bitrix';

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

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [isReady, setIsReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [currentUser, setCurrentUser] = useState<BX24User | null>(null);
  const [allUsers, setAllUsers] = useState<BX24User[]>([]);

  useEffect(() => {
    fetch('/api/me')
      .then((r) => r.json())
      .then(async (me: { userId?: string; userName?: string; isAdmin?: boolean }) => {
        setIsAdmin(me.isAdmin === true);
        if (me.userId) {
          try {
            const full = await getCurrentUserFull(me.userId);
            if (full) setCurrentUser(full);
          } catch {
            // show app without full user info
          }
        }
        setIsReady(true);
      })
      .catch(() => setIsReady(true));
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
