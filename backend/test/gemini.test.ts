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

const generated = () => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ intro: '사진에서 확인되는 인상이에요.' }) }] } }] }));
const analyzeWith = (fetcher: typeof fetch) => createGeminiProvider('test-key', 'test-model', fetcher, { attemptTimeoutMs: 20, retryDelaysMs: [0, 0] }).analyze(Buffer.from('photo'), 'image/png', new AbortController().signal);

test('rate limits, server errors, and network failures retry within one analysis', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('{}', { status: 429 }))
    .mockResolvedValueOnce(new Response('{}', { status: 503 }))
    .mockResolvedValueOnce(generated());
  expect((await analyzeWith(fetcher)).intro).toBe('사진에서 확인되는 인상이에요.');
  expect(fetcher).toHaveBeenCalledTimes(3);

  const network = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(generated());
  await expect(analyzeWith(network)).resolves.toMatchObject({ intro: '사진에서 확인되는 인상이에요.' });
  expect(network).toHaveBeenCalledTimes(2);
});

test('an aborted slow Gemini request is retried once', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockImplementationOnce((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }))
    .mockResolvedValueOnce(generated());
  await expect(analyzeWith(fetcher)).resolves.toMatchObject({ intro: '사진에서 확인되는 인상이에요.' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('a network error while reading the response body is transient', async () => {
  const interrupted = new Response('{}');
  interrupted.json = async () => { throw new TypeError('connection closed'); };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(interrupted).mockResolvedValueOnce(generated());
  await expect(analyzeWith(fetcher)).resolves.toMatchObject({ intro: '사진에서 확인되는 인상이에요.' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test.each([400, 401, 403])('HTTP %i is permanent and is not retried', async status => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}', { status })).mockResolvedValueOnce(generated());
  await expect(analyzeWith(fetcher)).rejects.toThrow('AI_UNAVAILABLE');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('invalid model output is permanent and retries stop after three transient failures', async () => {
  const invalid = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}')).mockResolvedValueOnce(generated());
  await expect(analyzeWith(invalid)).rejects.toThrow('AI_UNAVAILABLE');
  expect(invalid).toHaveBeenCalledTimes(1);

  const malformed = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: 'invalid' } }] }))).mockResolvedValueOnce(generated());
  await expect(analyzeWith(malformed)).rejects.toThrow('AI_UNAVAILABLE');
  expect(malformed).toHaveBeenCalledTimes(1);

  const unavailable = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 503 }));
  await expect(analyzeWith(unavailable)).rejects.toThrow('AI_UNAVAILABLE');
  expect(unavailable).toHaveBeenCalledTimes(3);
});
test('empty credentials are rejected', () => { expect(() => createGeminiProvider('', 'test-model')).toThrow(); });

test('real AI can be configured independently of demo Midnight', async () => {
  const { loadProviders } = await import('../src/providers.js');
  const { localConfig } = await import('../src/config.js');
  const providers = await loadProviders({ ...localConfig, aiMode: 'real', geminiApiKey: 'test-key', geminiModel: 'test-model' });
  expect(providers.ai?.mode).toBe('real');
});
