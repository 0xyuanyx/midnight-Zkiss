export interface AiResult {
  intro: string;
  tags?: string[];
  modelVersion: string;
  image?: { bytes: Buffer; mime: string; modelVersion: string };
}
export interface AiProfileContext {
  /** Explicit profile selection; never inferred from the uploaded photo. */
  gender: "male" | "female" | "unspecified";
}
export interface AiProvider {
  mode: "real" | "demo";
  analyze(
    photo: Buffer,
    mime: string,
    signal: AbortSignal,
    profile?: AiProfileContext,
  ): Promise<AiResult>;
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
