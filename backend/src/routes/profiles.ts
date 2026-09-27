import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { one } from "../db.js";
import {
  router,
  result,
  checkVersion,
  need,
  fail,
  id,
  versionInput,
  pagination,
  page,
} from "../http.js";
import type { Config } from "../config.js";
import { profile, publicProfile } from "../dto.js";
import { aiJobs } from "../ai-jobs.js";
import type { AiProvider } from "../adapters/ai.js";
export function profiles(
  app: FastifyInstance,
  pool: Pool,
  config: Config,
  ai?: AiProvider,
) {
  const jobs = aiJobs(app, pool, config, ai);
  const route = router(app, pool, config),
    E = "/events/:eventId";
  route(
    "PUT",
    E + "/me/profile",
    async (c) => {
      const b = z
        .object({
          expectedVersion: z.number().int().min(0),
          nickname: z.string().trim().min(1).max(30),
          age: z.number().int().min(18).max(100),
          gender: z.enum(["male", "female", "unspecified"]),
          mbti: z
            .string()
            .regex(/^[IE][NS][FT][JP]$/)
            .nullable()
            .optional(),
          introduction: z.string().trim().max(200).optional(),
          tags: z.array(z.string().trim().min(1).max(30)).max(5).optional(),
        })
        .strict()
        .parse(c.request.body);
      checkVersion(c.p.profile_version, b.expectedVersion);
      const { expectedVersion, ...fields } = b;
      const data = {
        ...fields,
        tags: fields.tags ?? c.p.profile?.tags ?? [],
        intro: c.p.profile?.intro,
        imageId: c.p.profile?.imageId,
        introSource: c.p.profile?.introSource ?? "ai",
      };
      const p = await one(
        c.db,
        "UPDATE participants SET profile=$2,profile_version=profile_version+1 WHERE id=$1 RETURNING *",
        [c.uid, JSON.stringify(data)],
      );
      return result(profile(p!));
    },
    { active: false, phase: "join" },
  );
  route(
    "POST",
    E + "/me/ai-jobs",
    async (c) => {
      need(ai && ai.mode === (config.aiMode ?? config.mode), 503, "AI_UNAVAILABLE");
      const b = c.request.body as { expectedVersion: number };
      checkVersion(c.p.profile_version, b.expectedVersion);
      need(c.p.profile, 409, "PROFILE_REQUIRED");
      const jobId = id("ai");
      const j = await one(
        c.db,
        "INSERT INTO ai_jobs(id,owner_id,profile_version,mode) VALUES($1,$2,$3,$4) RETURNING *",
        [jobId, c.uid, b.expectedVersion, ai!.mode],
      );
      return result(job(j!), 202);
    },
    {
      active: false,
      phase: "join",
      preprocess: jobs.preprocess,
      afterCommit: jobs.afterCommit,
    },
  );
  route(
    "GET",
    E + "/me/ai-jobs/:jobId",
    async (c) => {
      const j = await one(
        c.db,
        "SELECT * FROM ai_jobs WHERE id=$1 AND owner_id=$2",
        [c.params.jobId, c.uid],
      );
      need(j);
      return result(job(j));
    },
    { active: false },
  );
  route(
    "POST",
    E + "/me/profile/publication",
    async (c) => {
      const b = versionInput.parse(c.request.body);
      checkVersion(c.p.profile_version, b.expectedVersion);
      need(c.p.profile?.intro, 409, "PROFILE_REQUIRED");
      need(c.p.profile?.introSource === "ai", 409, "AI_RESULT_REQUIRED");
      need(
        await one(
          c.db,
          "SELECT 1 FROM ai_jobs WHERE owner_id=$1 AND status='succeeded' AND cleanup_status='service_cleaned' AND profile_version=$2 AND result=$3",
          [c.uid, c.p.profile_version, c.p.profile.intro],
        ),
        409,
        "AI_RESULT_REQUIRED",
      );
      const p = await one(
        c.db,
        "UPDATE participants SET profile_status='published',published_profile=profile,published_version=profile_version+1,profile_version=profile_version+1 WHERE id=$1 RETURNING *",
        [c.uid],
      );
      return result(profile(p!));
    },
    { phase: "join", idempotent: true },
  );
  route(
    "GET",
    E + "/feed",
    async (c) => {
      const { cursor, limit: n } = pagination(c);
      const filter = c.query.filter ?? "all";
      if (!["all", "open_to_answers"].includes(filter))
        fail(422, "FILTER_UNAVAILABLE");
      const questions = c.event.modes.includes("question_reply");
      if (filter === "open_to_answers" && !questions)
        fail(422, "FILTER_UNAVAILABLE");
      const rows = (
        await c.db.query(
          `SELECT p.*,q.id AS question_id,q.text AS question_text,q.version AS question_version,q.created_at AS question_created,
    l.sender_id IS NOT NULL AS liked, reverse.sender_id IS NOT NULL AS mutual,a.status AS answer_status
    FROM participants p LEFT JOIN questions q ON q.owner_id=p.id AND q.status='published' AND $5
    LEFT JOIN likes l ON l.sender_id=$2 AND l.recipient_id=p.id AND l.event_id=$1
    LEFT JOIN likes reverse ON reverse.sender_id=p.id AND reverse.recipient_id=$2 AND reverse.event_id=$1
    LEFT JOIN answers a ON a.question_id=q.id AND a.sender_id=$2
    WHERE p.event_id=$1 AND p.id<>$2 AND p.profile_status='published' AND p.admission_status='active'
    AND ($3::text IS NULL OR p.id>$3) AND ($6='all' OR (q.id IS NOT NULL AND a.id IS NULL))
    AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.event_id=$1 AND ((b.owner_id=$2 AND b.target_id=p.id) OR (b.target_id=$2 AND b.owner_id=p.id))) ORDER BY p.id LIMIT $4`,
          [c.event.id, c.uid, cursor ?? null, n + 1, questions, filter],
        )
      ).rows;
      const out = page(rows, n);
      return result({
        ...out,
        items: out.items.map((p) => ({
          id: p.id,
          kind: p.question_id ? "question" : "profile",
          author: publicProfile(p),
          profile: publicProfile(p),
          question: p.question_id
            ? {
                id: p.question_id,
                body: p.question_text,
                version: p.question_version,
                status: "open",
                createdAt: p.question_created,
              }
            : null,
          myLikeState: p.liked ? (p.mutual ? "matched" : "sent") : "none",
          myAnswerState: p.answer_status ?? "none",
          allowedActions: [
            ...(c.event.modes.includes("mutual_like") &&
            !p.liked &&
            c.p.profile_status === "published"
              ? ["like"]
              : []),
            ...(p.question_id && !p.answer_status ? ["answer"] : []),
          ],
        })),
      });
    },
    { phase: "discover" },
  );
  route(
    "GET",
    E + "/profiles/:profileId",
    async (c) => {
      const p = await one(
        c.db,
        "SELECT p.* FROM participants p WHERE p.id=$1 AND p.event_id=$2 AND p.profile_status='published' AND p.admission_status='active' AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.event_id=$2 AND ((b.owner_id=$3 AND b.target_id=p.id) OR (b.target_id=$3 AND b.owner_id=p.id)))",
        [c.params.profileId, c.event.id, c.uid],
      );
      need(p);
      return result(publicProfile(p));
    },
    { phase: "discover" },
  );
}
function job(j: Record<string, any>) {
  return {
    id: j.id,
    status: j.status,
    result: j.result,
    profileVersion: j.profile_version,
    cleanupStatus: j.cleanup_status,
    providerRetentionStatus: j.mode === "demo" ? "not_sent" : "unverified",
    mode: j.mode,
    failureCode: j.failure_code,
    modelVersion: j.model_version,
    serviceCleanedAt: j.service_cleaned_at,
  };
}
