-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "date" DATETIME NOT NULL,
    "endDate" DATETIME,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "location" TEXT,
    "rsvpLimit" INTEGER,
    "publicCode" TEXT NOT NULL,
    "manageToken" TEXT NOT NULL,
    "spotifyPlaylistId" TEXT,
    "theme" TEXT NOT NULL DEFAULT 'light',
    "primaryColor" TEXT,
    "secondaryColor" TEXT,
    "backgroundImage" TEXT,
    "emoji" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Event" ("backgroundImage", "createdAt", "date", "description", "emoji", "endDate", "id", "location", "manageToken", "primaryColor", "publicCode", "rsvpLimit", "secondaryColor", "spotifyPlaylistId", "theme", "title", "updatedAt", "userId") SELECT "backgroundImage", "createdAt", "date", "description", "emoji", "endDate", "id", "location", "manageToken", "primaryColor", "publicCode", "rsvpLimit", "secondaryColor", "spotifyPlaylistId", "theme", "title", "updatedAt", "userId" FROM "Event";
DROP TABLE "Event";
ALTER TABLE "new_Event" RENAME TO "Event";
CREATE UNIQUE INDEX "Event_publicCode_key" ON "Event"("publicCode");
CREATE UNIQUE INDEX "Event_manageToken_key" ON "Event"("manageToken");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
