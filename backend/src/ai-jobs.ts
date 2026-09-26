import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction, one } from "./db.js";
import { need, emit } from "./http.js";
import { readUpload, uploads } from "./upload.js";
import type { AiProvider } from "./adapters/ai.js";
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
        "SELECT * FROM ai_jobs WHERE id=$1 AND status='processing'",
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
        let response: { intro: string; modelVersion: string } | undefined;
        let failure = "AI_UNAVAILABLE";
        // Gemini makes up to three individually bounded attempts. This is a
        // final safety cap for a provider that does not settle after abort.
        const timer = setTimeout(() => controller.abort(), config.aiTimeoutMs * 3 + 15_000);
        try {
          response = z
            .object({
              intro: z.string().trim().min(1).max(500),
              modelVersion: z.string().min(1).max(200),
            })
            .parse(
              await Promise.race([
                ai!.analyze(bytes, upload.mime, controller.signal),
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
        } catch {
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
              await db.query(
                "UPDATE participants SET profile=$2,profile_version=$3 WHERE id=$1",
                [
                  p.id,
                  JSON.stringify({
                    ...p.profile,
                    intro: response.intro,
                    introSource: "ai",
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
