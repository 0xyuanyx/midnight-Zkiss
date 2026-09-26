-- Generated output only. Uploaded originals are never inserted here.
CREATE TABLE profile_images (
 id text PRIMARY KEY,
 owner_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
 mime text NOT NULL CHECK(mime = 'image/webp'),
 bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 5242880),
 model_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX profile_images_owner ON profile_images(owner_id);
