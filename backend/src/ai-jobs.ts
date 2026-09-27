import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction, one } from "./db.js";
import { need, emit, id } from "./http.js";
import { readUpload, uploads } from "./upload.js";
import sharp from "sharp";
import type { AiProvider, AiResult } from "./adapters/ai.js";
import type { Config } from "./config.js";
/** Bounded volatile photo jobs. Only job metadata survives process loss; retry needs re-upload. */
export function aiJobs(
  app: FastifyInstance,
  pool: Pool,
  config: Config,
  ai?: AiProvider,
) {
  let slots = 0;
  const queued = new WeakSet<FastifyRequest>();
  const tasks = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  app.addHook("preClose", async () => {
    for (const c of controllers) c.abort();
    await Promise.allSettled([...tasks]);
  });
  return {
    async preprocess(req: FastifyRequest) {
      need(ai && ai.mode === (config.aiMode ?? config.mode), 503, "AI_UNAVAILABLE");
      need(slots < 2, 503, "AI_UNAVAILABLE");
      slots++;
      try {
        const cleanup = await readUpload(req);
        return () => {
          cleanup();
          if (!queued.has(req)) slots--;
        };
      } catch (e) {
        slots--;
        throw e;
      }
    },
    async afterCommit(req: FastifyRequest, data: unknown) {
      const jobId = (data as { id: string }).id;
      // A replay returns an existing job; never submit the same photo to the provider twice.
      const job = await one(
        pool,
        "SELECT j.*, p.profile AS profile_input FROM ai_jobs j JOIN participants p ON p.id=j.owner_id WHERE j.id=$1 AND j.status='processing'",
        [jobId],
      );
      if (!job) return;
      const upload = uploads.get(req)!;
      const bytes = Buffer.from(upload.bytes);
      queued.add(req);
      const controller = new AbortController();
      controllers.add(controller);
      let task: Promise<void>;
      task = (async () => {
        let response: AiResult | undefined;
        let failure = "AI_UNAVAILABLE";
        const timer = setTimeout(() => controller.abort(), config.aiTimeoutMs);
        try {
          response = z
            .object({
              intro: z.string().trim().min(1).max(500),
              tags: z.array(z.string().trim().min(1).max(8)).max(2).optional(),
              modelVersion: z.string().min(1).max(200),
              image: z.object({ bytes: z.instanceof(Buffer).refine(b => b.length > 0 && b.length <= 12 * 1024 * 1024), mime: z.enum(['image/png', 'image/jpeg', 'image/webp']), modelVersion: z.string().min(1).max(200) }).optional(),
            })
            .parse(
              await Promise.race([
                ai!.analyze(bytes, upload.mime, controller.signal, { gender: ["male", "female"].includes(job.profile_input?.gender) ? job.profile_input.gender : "unspecified" }),
                new Promise<never>((_, reject) => {
                  if (controller.signal.aborted) reject(new Error("aborted"));
                  else
                    controller.signal.addEventListener(
                      "abort",
                      () => reject(new Error("aborted")),
                      { once: true },
                    );
                }),
              ]),
            );
          if (config.requireGeneratedImage && !response.image) throw new Error('AI_IMAGE_REQUIRED');
          if (response.image) {
            const generated = response.image;
            try {
              const decoder = sharp(generated.bytes, { limitInputPixels: 20_000_000 });
              if (((await decoder.metadata()).pages ?? 1) !== 1) throw new Error('AI_IMAGE_UNAVAILABLE');
              response.image = { ...generated, mime: 'image/webp', bytes: await decoder.resize(1024, 1024, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer() };
              if (response.image.bytes.length > 5 * 1024 * 1024) throw new Error('AI_IMAGE_UNAVAILABLE');
            } finally { generated.bytes.fill(0); }
          }
          if (controller.signal.aborted) throw new Error('AI_UNAVAILABLE');
        } catch (error) {
          if (error instanceof Error && ['AI_IMAGE_UNAVAILABLE', 'AI_IMAGE_REQUIRED', 'AI_QUOTA_EXCEEDED'].includes(error.message)) failure = error.message;
          response = undefined;
        } finally {
          clearTimeout(timer);
          bytes.fill(0);
          controllers.delete(controller);
        }
        try {
          await transaction(pool, async (db) => {
            const initial = await one(
              db,
              "SELECT event_id FROM participants WHERE id=$1",
              [job.owner_id],
            );
            if (!initial) return;
            const event = (await one(
              db,
              "SELECT * FROM events WHERE id=$1 FOR UPDATE",
              [initial.event_id],
            ))!;
            const p = (await one(db, "SELECT * FROM participants WHERE id=$1", [
              job.owner_id,
            ]))!;
            const current = await one(
              db,
              "SELECT * FROM ai_jobs WHERE id=$1 AND status='processing' FOR UPDATE",
              [jobId],
            );
            if (!current) return;
            let version = job.profile_version;
            if (
              response &&
              (p.profile_version !== job.profile_version ||
                !["active", "onboarding", "admission_pending"].includes(
                  p.admission_status,
                ) ||
                event.status !== "open" ||
                new Date(event.join_until).getTime() <= Date.now())
            ) {
              response = undefined;
              failure = "PROFILE_CHANGED";
            }
            if (response) {
              version = p.profile_version + 1;
              const imageId = response.image ? id('img') : null;
              if (response.image) await db.query('INSERT INTO profile_images(id,owner_id,mime,bytes,model_version) VALUES($1,$2,$3,$4,$5)', [imageId, p.id, response.image.mime, response.image.bytes, response.image.modelVersion]);
              await db.query(
                "UPDATE participants SET profile=$2,profile_version=$3 WHERE id=$1",
                [
                  p.id,
                  JSON.stringify({
                    ...p.profile,
                    intro: response.intro,
                    tags: response.tags ?? [],
                    introSource: "ai",
                    imageId,
                  }),
                  version,
                ],
              );
              await emit(
                { db, event },
                p.id,
                "profile.updated",
                p.id,
                null,
                version,
              );
            }
            await db.query(
              "UPDATE ai_jobs SET status=$2,result=$3,profile_version=$4,cleanup_status='service_cleaned',failure_code=$5,model_version=$6,service_cleaned_at=now() WHERE id=$1",
              [
                jobId,
                response ? "succeeded" : "failed",
                response?.intro ?? null,
                version,
                response ? null : failure,
                response?.modelVersion ?? null,
              ],
            );
            await emit({ db, event }, p.id, "ai.updated", jobId);
          });
        } catch {
          console.error(
            JSON.stringify({ code: "AI_RESULT_PERSIST_FAILED", jobId }),
          );
        }
      })().finally(() => {
        slots--;
        tasks.delete(task);
      });
      tasks.add(task);
    },
  };
}
