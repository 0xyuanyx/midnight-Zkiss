import { expect, test, vi } from 'vitest';
import { createGeminiProvider } from '../src/adapters/gemini.js';
test('sends photo bytes and returns generated description', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ intro: '밝은 미소와 단정한 옷차림이 보입니다.' }) }] } }], modelVersion: 'test-model' })));
  const photo = Buffer.from('synthetic-photo');
  const result = await createGeminiProvider('test-key', 'test-model', fetcher).analyze(photo, 'image/png', new AbortController().signal);
  expect(result.intro).toBe('밝은 미소와 단정한 옷차림이 보입니다.');
  const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
  expect(body.contents[0].parts[1].inlineData).toEqual({ mimeType: 'image/png', data: photo.toString('base64') });
});
test('provider failures never produce a demo description', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 429 }));
  await expect(createGeminiProvider('test-key', 'test-model', fetcher).analyze(Buffer.from('photo'), 'image/png', new AbortController().signal)).rejects.toThrow('AI_UNAVAILABLE');
});
test('empty credentials are rejected', () => { expect(() => createGeminiProvider('', 'test-model')).toThrow(); });

test('real AI can be configured independently of demo Midnight', async () => {
  const { loadProviders } = await import('../src/providers.js');
  const { localConfig } = await import('../src/config.js');
  const providers = await loadProviders({ ...localConfig, aiMode: 'real', geminiApiKey: 'test-key', geminiModel: 'test-model' });
  expect(providers.ai?.mode).toBe('real');
});
