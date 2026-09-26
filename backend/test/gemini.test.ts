import { expect, test, vi } from 'vitest';
import { createGeminiProvider } from '../src/adapters/gemini.js';
test('sends photo bytes and returns generated description', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ tags: ['또렷한 눈매', '단정한 헤어'], intro: '밝은 미소와 단정한 옷차림이 보입니다.' }) }] } }], modelVersion: 'test-model' })));
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
  const providers = await loadProviders({ ...localConfig, aiMode: 'real', geminiApiKey: 'test-key', geminiModel: 'test-model', geminiImageModel: 'test-image-model' });
  expect(providers.ai?.mode).toBe('real');
});

test('uses separate source-pose and fictional-character style references', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ tags: ['또렷한 눈매', '단정한 헤어'], intro: '밝은 옷차림과 자연스러운 헤어스타일이에요.' }) }] } }] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ modelVersion: 'image-test', candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from('synthetic-generated-output').toString('base64') } }] } }] })));
  const result = await createGeminiProvider('test-key', 'text-model', fetcher, 'image-model').analyze(Buffer.from('original-photo'), 'image/png', new AbortController().signal);
  expect(result.image?.bytes.toString()).toBe('synthetic-generated-output');
  expect(result.tags).toEqual(['또렷한 눈매', '단정한 헤어']);
  expect(fetcher.mock.calls[1][0]).toContain('/image-model:generateContent');
  const body = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
  expect(body.generationConfig.responseModalities).toContain('IMAGE');
  expect(body.contents[0].parts[0].text).toContain('IMAGE 1 is the user');
  expect(body.contents[0].parts[0].text).toContain('Keep the visible hand gesture');
  expect(body.contents[0].parts[0].text).toContain('Do NOT reconstruct');
  expect(body.contents[0].parts[1].inlineData.mimeType).toBe('image/png');
  expect(body.contents[0].parts[0].text).toContain(result.intro);
  expect(body.contents[0].parts[1].inlineData.data).toBe(Buffer.from('original-photo').toString('base64'));
  expect(body.contents[0].parts).toHaveLength(3);
  expect(body.contents[0].parts[2].inlineData.mimeType).toBe('image/png');
  expect(body.contents[0].parts[2].inlineData.data).not.toBe(body.contents[0].parts[1].inlineData.data);
});

test('image generation failure cannot turn into successful text-only output', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"intro":"분석 결과","tags":["또렷한 눈매","단정한 헤어"]}' }] } }] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'cannot create image' }] } }] })));
  await expect(createGeminiProvider('test-key', 'text-model', fetcher, 'image-model').analyze(Buffer.from('photo'), 'image/png', new AbortController().signal)).rejects.toThrow('AI_IMAGE_UNAVAILABLE');
});

test.each([['male', 'one adult man'], ['female', 'one adult woman'], ['unspecified', 'No gender was specified'] ] as const)('uses explicitly selected %s for avatar generation', async (gender, subject) => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({tags:['또렷한 눈매','단정한 헤어'],intro:'또렷한 눈매와 짧은 머리가 단정한 인상을 만들어요.'})}]}}]})))
    .mockResolvedValueOnce(new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{inlineData:{mimeType:'image/png',data:Buffer.from('image').toString('base64')}}]}}]})));
  await createGeminiProvider('test','text',fetcher,'image').analyze(Buffer.from('photo'),'image/png',new AbortController().signal,{gender});
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).contents[0].parts[0].text).toContain(subject);
});

test('retries an overlong introduction before generating the image and normalizes paragraph breaks', async () => {
  const response = (intro: string) => new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({intro,tags:['또렷한 눈매','단정한 헤어']})}]}}]}));
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response('가'.repeat(101))).mockResolvedValueOnce(response('또렷한 눈매가 돋보여요.\n\n짧은 머리가 단정한 인상을 더해요.'));
  const result = await createGeminiProvider('test','text',fetcher).analyze(Buffer.from('photo'),'image/png',new AbortController().signal);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(result.intro).toBe('또렷한 눈매가 돋보여요. 짧은 머리가 단정한 인상을 더해요.');
});

test('never saves an overlong introduction or silently cuts off its sentence', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async()=>new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({tags:['또렷한 눈매','단정한 헤어'],intro:'가'.repeat(101)})}]}}]})));
  await expect(createGeminiProvider('test','text',fetcher,'image').analyze(Buffer.from('photo'),'image/png',new AbortController().signal)).rejects.toThrow('AI_DESCRIPTION_TOO_LONG');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
