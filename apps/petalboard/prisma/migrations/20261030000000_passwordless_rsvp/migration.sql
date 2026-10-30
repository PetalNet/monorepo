-- Guest email becomes the identity for editing an RSVP, so store it the way the app compares it.
UPDATE "Rsvp" SET "email" = lower(trim("email", ' ' || char(9) || char(10) || char(13))) WHERE "email" IS NOT NULL;
UPDATE "Rsvp" SET "email" = NULL WHERE "email" = '';

-- Make (eventId, email) unique without deleting anyone: the most recently updated RSVP keeps the
-- address, older duplicates keep their row but lose the email and can no longer be edited.
UPDATE "Rsvp" SET "email" = NULL
WHERE "email" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Rsvp" AS "newer"
    WHERE "newer"."eventId" = "Rsvp"."eventId"
      AND "newer"."email" = "Rsvp"."email"
      AND ("newer"."updatedAt" > "Rsvp"."updatedAt"
        OR ("newer"."updatedAt" = "Rsvp"."updatedAt" AND "newer"."id" > "Rsvp"."id"))
);

-- CreateTable
CREATE TABLE "RsvpSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "rsvpId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "RsvpSession_rsvpId_fkey" FOREIGN KEY ("rsvpId") REFERENCES "Rsvp" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RsvpLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "rsvpId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    CONSTRAINT "RsvpLink_rsvpId_fkey" FOREIGN KEY ("rsvpId") REFERENCES "Rsvp" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Rsvp" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "status" TEXT NOT NULL DEFAULT 'attending',
    "guestCount" INTEGER NOT NULL DEFAULT 1,
    "eventId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Rsvp_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Rsvp" ("createdAt", "email", "eventId", "guestCount", "id", "name", "status", "updatedAt") SELECT "createdAt", "email", "eventId", "guestCount", "id", "name", "status", "updatedAt" FROM "Rsvp";
DROP TABLE "Rsvp";
ALTER TABLE "new_Rsvp" RENAME TO "Rsvp";
CREATE UNIQUE INDEX "Rsvp_eventId_email_key" ON "Rsvp"("eventId", "email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "RsvpSession_tokenHash_key" ON "RsvpSession"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "RsvpLink_tokenHash_key" ON "RsvpLink"("tokenHash");

