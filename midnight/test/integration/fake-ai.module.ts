// 통합 테스트 전용 가짜 AI 제공자(AI_PROVIDER_MODULE). 사진을 분석하지 않는다. 실제 AI가 아니다.
// real 모드 백엔드는 AI 제공자가 있어야 프로필을 게시할 수 있어서, Midnight 연동 검증용으로만 쓴다.
export default {
  mode: 'real' as const,
  async analyze(_photo: Buffer, _mime: string, _signal: AbortSignal) {
    return { intro: '[통합 테스트] 실제 사진 분석이 아닌 고정 소개문입니다.', modelVersion: 'it-fake-ai' };
  },
};
