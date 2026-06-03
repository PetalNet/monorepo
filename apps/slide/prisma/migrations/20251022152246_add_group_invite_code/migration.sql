/*
  Warnings:

  - Added the required column `inviteCode` to the `Group` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "GroupMember_groupId_userId_key";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Group" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "inviteCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emoji" TEXT,
    "logo" TEXT,
    "presentationType" TEXT NOT NULL,
    "submissionLink" TEXT,
    "submissionFile" TEXT,
    "status" TEXT NOT NULL DEFAULT 'not_submitted',
    "submittedAt" DATETIME,
    "presentationOrder" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Group_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Generate invite codes for existing groups
INSERT INTO "new_Group" ("createdAt", "emoji", "eventId", "id", "inviteCode", "logo", "name", "presentationOrder", "presentationType", "status", "submissionFile", "submissionLink", "submittedAt", "updatedAt") 
SELECT "createdAt", "emoji", "eventId", "id", substr(hex(randomblob(4)), 1, 8) as "inviteCode", "logo", "name", "presentationOrder", "presentationType", "status", "submissionFile", "submissionLink", "submittedAt", "updatedAt" FROM "Group";
DROP TABLE "Group";
ALTER TABLE "new_Group" RENAME TO "Group";
CREATE UNIQUE INDEX "Group_inviteCode_key" ON "Group"("inviteCode");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
