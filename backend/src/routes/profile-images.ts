import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { one } from '../db.js';
import { authenticate, need } from '../http.js';

export function profileImages(app: FastifyInstance, pool: Pool) {
  app.get<{ Params: { eventId: string; imageId: string } }>('/api/v1/events/:eventId/profile-images/:imageId', async (req, reply) => {
    const viewer = await authenticate(pool, req);
    need(viewer.event_id === req.params.eventId);
    const image = await one(pool, `SELECT i.mime,i.bytes FROM profile_images i JOIN participants p ON p.id=i.owner_id JOIN events e ON e.id=p.event_id
      WHERE i.id=$1 AND p.event_id=$2 AND (p.id=$3 OR (
        $4='active' AND p.admission_status='active' AND p.profile_status='published'
        AND p.published_profile->>'imageId'=i.id AND e.status='open' AND e.discover_until>now()
        AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.event_id=e.id AND ((b.owner_id=$3 AND b.target_id=p.id) OR (b.owner_id=p.id AND b.target_id=$3)))
      ))`, [req.params.imageId, viewer.event_id, viewer.id, viewer.admission_status]);
    need(image);
    return reply.type(image.mime).send(image.bytes);
  });
}
