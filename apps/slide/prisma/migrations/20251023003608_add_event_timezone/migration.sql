-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "theme" TEXT,
    "description" TEXT,
    "joinCode" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "submissionDeadline" DATETIME,
    "maxPresentationTime" INTEGER,
    "submissionsClosed" BOOLEAN NOT NULL DEFAULT false,
    "orderMode" TEXT NOT NULL,
    "visibility" TEXT NOT NULL,
    "allowLateSubmissions" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'setup',
    "currentPresentationId" TEXT,
    "judgingOpen" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Event_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Event" ("allowLateSubmissions", "createdAt", "currentPresentationId", "description", "hostId", "id", "joinCode", "judgingOpen", "maxPresentationTime", "name", "orderMode", "status", "submissionDeadline", "submissionsClosed", "theme", "updatedAt", "visibility") SELECT "allowLateSubmissions", "createdAt", "currentPresentationId", "description", "hostId", "id", "joinCode", "judgingOpen", "maxPresentationTime", "name", "orderMode", "status", "submissionDeadline", "submissionsClosed", "theme", "updatedAt", "visibility" FROM "Event";
DROP TABLE "Event";
ALTER TABLE "new_Event" RENAME TO "Event";
CREATE UNIQUE INDEX "Event_joinCode_key" ON "Event"("joinCode");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
