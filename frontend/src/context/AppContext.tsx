import React, { createContext, useContext, useEffect, useState } from 'react';
import type { BX24User } from '../types';
import { bx24Init, bx24IsAdmin, getCurrentUserFull, bx24GetUser } from '../api/bitrix';

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
    bx24Init().then(async () => {
      const admin = bx24IsAdmin();
      setIsAdmin(admin);
      try {
        const raw = bx24GetUser();
        const full = await getCurrentUserFull(raw.ID);
        setCurrentUser(full);
      } catch {
        // fallback
      }
      setIsReady(true);
    });
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
