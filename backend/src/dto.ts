import type { Row, Db } from "./db.js";
import { one } from "./db.js";
export function profile(p: Row) {
  return {
    id: p.id,
    profileId: p.id,
    version: p.profile_version,
    status: p.profile_status,
    ...(p.profile ?? {}),
  };
}
export function publicProfile(p: Row) {
  const x = p.published_profile ?? {};
  return {
    id: p.id,
    profileId: p.id,
    version: p.published_version,
    nickname: x.nickname,
    age: x.age,
    gender: x.gender,
    intro: x.intro ?? "",
    introSource: x.introSource ?? "ai",
    tags: x.tags ?? [],
    mbti: x.mbti ?? null,
  };
}
export function contact(p: Row) {
  return {
    version: p.contact_version,
    configured: !!p.contact,
    commitment: p.contact?.commitment ?? null,
    keyVersion: p.device_key_version,
  };
}
export function me(p: Row, config: { mode: string }) {
  return {
    mode: config.mode,
    participantId: p.id,
    eventId: p.event_id,
    admissionStatus: p.admission_status,
    ticket: { leaf: p.ticket_leaf ?? null, status: p.ticket_status ?? null },
    csrfToken: p.csrf_token,
    profile: profile(p),
    contact: contact(p),
  };
}
export async function conversation(
  db: Db,
  r: Row,
  uid: string,
  capabilities = { reveal: false, anonymousReveal: false },
) {
  const event = (await one(db, "SELECT * FROM events WHERE id=$1", [
    r.event_id,
  ]))!;
  const request = await one(
    db,
    "SELECT id FROM reveal_requests WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
    [r.id],
  );
  const canReveal =
    event.sns_reveal &&
    capabilities.reveal &&
    (r.origin !== "question_reply" || capabilities.anonymousReveal);
  const peerId = r.a === uid ? r.b : r.a;
  const p = await one(db, "SELECT * FROM participants WHERE id=$1", [peerId]);
  const last = await one(
    db,
    "SELECT text,created_at,sequence FROM messages WHERE conversation_id=$1 ORDER BY sequence DESC LIMIT 1",
    [r.id],
  );
  const read = await one(
    db,
    "SELECT sequence FROM read_states WHERE conversation_id=$1 AND participant_id=$2",
    [r.id, uid],
  );
  const unread = await one(
    db,
    "SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND sender_id<>$2 AND sequence>$3",
    [r.id, uid, read?.sequence ?? 0],
  );
  return {
    id: r.id,
    origin: r.origin,
    status: r.status,
    version: r.version,
    peer:
      r.origin === "question_reply" && uid === r.a
        ? { identity: "anonymous", label: r.alias }
        : { identity: "public_profile", profile: publicProfile(p!) },
    unreadCount: unread!.n,
    lastSequence: last?.sequence ?? 0,
    lastMessage:
      r.status === "active" && last
        ? { text: last.text, createdAt: last.created_at }
        : null,
    chatUntil: event.chat_until,
    freeUntil: null,
    revealRequestId: request?.id ?? null,
    allowedActions:
      r.status === "active"
        ? [
            "send_message",
            ...(canReveal ? ["request_reveal"] : []),
            "leave",
            "report",
            "block",
          ]
        : ["report"],
  };
}
export const message = (r: Row, uid: string) => ({
  id: r.id,
  clientMessageId: r.client_message_id,
  sequence: r.sequence,
  sender: r.sender_id === uid ? "self" : "peer",
  text: r.text,
  createdAt: r.created_at,
});
