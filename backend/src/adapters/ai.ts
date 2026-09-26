export interface AiProvider {
  mode: "real" | "demo";
  analyze(
    photo: Buffer,
    mime: string,
    signal: AbortSignal,
  ): Promise<{ intro: string; modelVersion: string }>;
}
export const demoAi: AiProvider = {
  mode: "demo",
  async analyze() {
    return {
      intro: "[데모] 실제 사진을 분석하지 않은 소개 예시입니다.",
      modelVersion: "demo-v1",
    };
  },
};
