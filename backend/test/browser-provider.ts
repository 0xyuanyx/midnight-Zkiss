/** Synthetic provider for browser integration tests. Never a real Gemini result. */
import sharp from 'sharp';
import type { AiProvider } from '../src/adapters/ai.js';
if (process.env.NODE_ENV !== 'test') throw new Error('TEST_PROVIDER_ONLY');
const provider: AiProvider = {
  mode: 'real',
  async analyze() {
    return {
      intro: '[테스트] 이미지 저장과 표시를 검증하는 합성 응답입니다.',
      modelVersion: 'synthetic-browser-test',
      image: { bytes: await sharp({ create: { width: 32, height: 32, channels: 3, background: '#e4cfee' } }).png().toBuffer(), mime: 'image/png', modelVersion: 'synthetic-image-test' },
    };
  },
};
export default provider;
