const base = '/api/v1';
export const eventId = import.meta.env.VITE_EVENT_ID || 'evt_integration';
export const eventPath = `/events/${encodeURIComponent(eventId)}`;
export type ApiError = Error & { code?: string; status?: number };
let csrf = '';
export function setCsrf(value?: string) { csrf = value ?? ''; }
export function getCsrf() { return csrf; }
export async function api<T>(path: string, options: { method?: string; body?: unknown; form?: FormData; idempotencyKey?: string } = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method) && csrf) headers['X-CSRF-Token'] = csrf;
  if (method === 'POST' && path !== '/sessions') headers['Idempotency-Key'] = options.idempotencyKey ?? crypto.randomUUID();
  const response = await fetch(base + path, {
    method, headers, credentials: 'same-origin',
    body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const code = payload?.error?.code ?? `HTTP_${response.status}`;
    const error = new Error(code) as ApiError;
    error.code = code;
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()).data as T;
}
export async function restoreSession(): Promise<LiveMe | null> {
  try { const me = await api<LiveMe>('/me'); setCsrf(me.csrfToken); return me; }
  catch (error) { if ((error as ApiError).status === 401) { setCsrf(); return null; } throw error; }
}
export type LiveMe = { mode?: string; contact?: { version: number; configured: boolean; commitment: string | null; keyVersion: number }; participantId: string; eventId: string; csrfToken: string; admissionStatus: string; profile: { version: number; status: string; intro?: string; introduction?: string; nickname?: string; age?: number; gender?: string; mbti?: string }; ticket: { leaf: string | null; status: string | null } };
export type PublicProfile = { id: string; nickname: string; age: number; intro: string; introduction?: string; mbti: string | null; tags: string[] };
export type FeedItem = { id: string; profile: PublicProfile; myLikeState: 'none' | 'sent' | 'matched'; allowedActions: string[] };
export type Room = { revealRequestId?: string | null; chatUntil?: string; id: string; status: string; version: number; origin: string; peer: { identity: string; profile?: PublicProfile; label?: string }; unreadCount: number; lastMessage?: { text: string }; allowedActions: string[] };
export type Message = { id: string; sequence: number; sender: 'self' | 'peer'; text: string };
export type Page<T> = { items: T[]; nextCursor: string | null };
