-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Rsvp" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "status" TEXT NOT NULL DEFAULT 'attending',
    "guestCount" INTEGER NOT NULL DEFAULT 1,
    "pinHash" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Rsvp_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Rsvp" ("createdAt", "email", "eventId", "id", "name", "pinHash", "status", "updatedAt") SELECT "createdAt", "email", "eventId", "id", "name", "pinHash", "status", "updatedAt" FROM "Rsvp";
DROP TABLE "Rsvp";
ALTER TABLE "new_Rsvp" RENAME TO "Rsvp";
CREATE UNIQUE INDEX "Rsvp_eventId_pinHash_key" ON "Rsvp"("eventId", "pinHash");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
