interface BX24Auth {
  access_token: string;
  domain: string;
  expires_in: number;
  member_id: string;
}

interface BX24Object {
  init(callback: () => void): void;
  getAuth(): BX24Auth | null;
  refreshAuth(callback: (auth: BX24Auth) => void): void;
}

declare global {
  interface Window {
    BX24?: BX24Object;
  }
}

export {};
