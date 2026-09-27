export interface ApiProfile { id: string; version: number; status?: string; nickname?: string; age?: number; gender?: string; mbti?: string; intro?: string; introduction?: string; tags?: string[]; imageUrl?: string | null }
export interface Me { mode: 'demo' | 'real'; participantId: string; eventId: string; csrfToken: string; admissionStatus: string; devicePublicKey?: string | null; ticket: { leaf: string | null; status: string | null }; profile: ApiProfile; contact: { version: number; configured: boolean; keyVersion: number } }
export interface EventInfo { id: string; name: string; mode: 'demo' | 'real'; aiMode: 'demo' | 'real'; aiReady: boolean; participantCount: number; features: { snsReveal: boolean } }
export interface Room { chainPreparation?: { roomId: string; network: string; contractAddress: string; eventScope: string; status: string; mySlot: string | null } | null; id: string; version: number; status: string; peer: { profile?: ApiProfile }; unreadCount: number; lastSequence: number; revealRequestId: string | null; allowedActions: string[] }
export interface ApiMessage { id: string; sequence: number; sender: 'self' | 'peer'; text: string }
export interface Reveal { mySlotIndex: 0 | 1; chainRoomId: string; eventScope: string | null; contractAddress: string | null; network: string | null; terms: string | null; id: string; version: number; status: string; myDecision: string; peerDecision: string; transcriptHash: string | null; myMaterialReady: boolean; myEnvelopeReady: boolean; peerEncryptionKey: { publicKey: string; version: number } | null }
export class ApiError extends Error { constructor(public code: string, public status = 0) { super(code); } }
export class Api {
  csrf = '';
  eventId = '';
  async request<T>(path: string, method = 'GET', body?: unknown, key = crypto.randomUUID()): Promise<T> {
    const headers: Record<string, string> = {};
    if (method !== 'GET') { headers['x-csrf-token'] = this.csrf; headers['idempotency-key'] = key; }
    const multipart = body instanceof FormData;
    if (multipart && body.has('expectedVersion')) {
      const version = body.get('expectedVersion');
      if (typeof version !== 'string' || !/^\d+$/.test(version)) throw new ApiError('VALIDATION_ERROR');
      headers['x-profile-version'] = version;
    }
    if (body !== undefined && !multipart) headers['content-type'] = 'application/json';
    let response: Response;
    try { response = await fetch(`/api/v1${path}`, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : multipart ? body : JSON.stringify(body), signal: AbortSignal.timeout(20000) }); }
    catch { throw new ApiError('NETWORK_ERROR'); }
    if (response.status === 204) return undefined as T;
    const result = await response.json().catch(() => ({}));
    if (response.ok && !('data' in result)) throw new ApiError('INVALID_API_RESPONSE');
    if (!response.ok) throw new ApiError(result.error?.code ?? 'SERVER_ERROR', response.status);
    return result.data as T;
  }
  event<T>(path: string, method = 'GET', body?: unknown) { return this.request<T>(`/events/${encodeURIComponent(this.eventId)}${path}`, method, body); }
  async all<T>(path: string): Promise<T[]> {
    const items: T[] = []; let cursor: string | null = null;
    do {
      const page: { items: T[]; nextCursor: string | null } = await this.event(`${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      items.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    return items;
  }
}
export const pause = (ms = 1500) => new Promise(resolve => setTimeout(resolve, ms));
export function errorMessage(error: unknown) {
  const code = error instanceof ApiError ? error.code : '';
  const messages: Record<string, string> = {
    SERVICE_NOT_CONFIGURED: '아직 서버 연결을 준비 중이에요. 잠시 후 다시 방문해 주세요.',
    INVALID_API_RESPONSE: 'API 응답을 읽을 수 없어요. 개발 서버의 /api 프록시 설정을 확인해 주세요.',
    INVALID_PHOTO: '사진 파일을 읽을 수 없거나 해상도가 너무 높아요. 2,000만 화소 이하의 JPG 또는 PNG 사진으로 다시 선택해 주세요.',
    UNSUPPORTED_MEDIA_TYPE: '지원하지 않는 사진 형식이에요. JPG, PNG, WebP 사진을 선택해 주세요.',
    FILE_TOO_LARGE: '사진 용량이 너무 커요. 5MB 이하의 사진을 선택해 주세요.',
    VALIDATION_ERROR: '입력 정보나 사진 형식을 확인한 뒤 다시 시도해 주세요.',
    PHOTO_REQUIRED: '분석할 사진을 다시 선택해 주세요.',
    NETWORK_ERROR: '서버에 연결할 수 없어요. 연결을 확인하고 다시 시도해 주세요.',
    SESSION_REQUIRED: '행사 입장이 필요해요.', SESSION_EXPIRED: '세션이 만료됐어요. 다시 입장해 주세요.',
    EVENT_CLOSED: '행사 이용 시간이 종료됐어요.', VERSION_CONFLICT: '정보가 변경됐어요. 새로고침 후 다시 시도해 주세요.',
    AI_QUOTA_EXCEEDED: '이미지 생성 서비스를 잠시 이용할 수 없어요. 운영자에게 알려 주세요.',
    SNS_KEY_PREPARATION_FAILED: '이 브라우저에서 공개 정보를 준비하지 못했어요. 새로고침 후 다시 시도해 주세요.',
    SLOT_CHANGED: '처음 공개를 요청했던 탭의 정보가 필요해요. 원래 탭에서 다시 시도해 주세요.',
    MATERIAL_CHANGED: '공개 정보가 다른 탭에서 변경됐어요. 처음 요청했던 탭에서 다시 시도해 주세요.',
    SNS_APPROVAL_FAILED: 'SNS 공개를 완료하지 못했어요. 운영자에게 알려 주세요.',
    PROOF_ASSET_UNAVAILABLE: '공개 준비 파일을 불러오지 못했어요. 연결을 확인하고 공개 준비 다시 시도를 눌러 주세요.',
    PROOF_FAILED: '공개 준비를 완료하지 못했어요. 잠시 후 다시 시도해 주세요.',
    PROOF_TIMEOUT: '공개 준비가 지연되고 있어요. 잠시 후 다시 시도해 주세요.',
    AI_IMAGE_REQUIRED: '프로필 이미지를 만들지 못했어요. 다시 시도해 주세요.',
    AI_IMAGE_UNAVAILABLE: '프로필 이미지를 만들지 못했어요. 다시 시도해 주세요.',
    ADMISSION_REQUIRED: '입장을 완료하지 못했어요. 다시 시도해 주세요.',
    AI_UNAVAILABLE: 'AI 분석을 사용할 수 없어요. 잠시 후 다시 시도해 주세요.',
    RATE_LIMITED: '요청이 많아요. 잠시 후 다시 시도해 주세요.', CONTACT_REQUIRED: '두 사람 모두 SNS 정보를 먼저 등록해야 해요.',
    WALLET_REQUIRED: 'SNS 공개 연결을 준비 중이에요. 잠시 후 다시 시도해 주세요.',
    WORKER_TIMEOUT: '입장 처리가 지연되고 있어요. 백엔드 워커 실행 상태를 확인해 주세요.',
    KEYS_MISSING: '프로필을 등록했던 원래 탭에서 SNS 공개를 진행해 주세요.',
  };
  return messages[code] ?? '요청을 완료하지 못했어요. 다시 시도해 주세요.';
}
