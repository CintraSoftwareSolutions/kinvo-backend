-- A message carries what the sending app called it, so a send that timed out
-- and is tried again is recognised as the same message instead of arriving
-- twice.
ALTER TABLE "messages" ADD COLUMN "client_token" VARCHAR(64);

-- Partial, because most rows have no token: every message sent before this
-- existed, and any client that sends none. A plain unique index would make all
-- of those collide with each other.
--
-- Scoped to the sender as well as the conversation: two people cannot be made
-- to collide by one of them choosing an awkward token.
CREATE UNIQUE INDEX "messages_conversation_id_sender_id_client_token_key"
  ON "messages" ("conversation_id", "sender_id", "client_token")
  WHERE "client_token" IS NOT NULL;
