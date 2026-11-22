CREATE TABLE IF NOT EXISTS "ResetRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "relicId" TEXT NOT NULL,
    "reason" TEXT,
    "requestedBy" TEXT,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "ResetRequest_relicId_fkey" FOREIGN KEY ("relicId") REFERENCES "Relic" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "RelicType" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "RelicVariety" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "typeId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RelicVariety_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "RelicType" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "RelicType_name_key" ON "RelicType"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "RelicVariety_typeId_name_key" ON "RelicVariety"("typeId", "name");
CREATE TABLE IF NOT EXISTS "AllocationRange" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "typeId" INTEGER NOT NULL,
    "varietyId" INTEGER NOT NULL,
    "startIndex" INTEGER,
    "endIndex" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "color" TEXT, "lore" TEXT, "writtenIndices" TEXT DEFAULT '[]',
    CONSTRAINT "AllocationRange_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "RelicType" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AllocationRange_varietyId_fkey" FOREIGN KEY ("varietyId") REFERENCES "RelicVariety" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "AllocationRange_typeId_varietyId_startIndex_endIndex_key" ON "AllocationRange"("typeId", "varietyId", "startIndex", "endIndex");
CREATE TABLE IF NOT EXISTS "RelicSet" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "SetMember" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "setId" INTEGER NOT NULL,
    "typeId" INTEGER NOT NULL,
    "varietyId" INTEGER,
    CONSTRAINT "SetMember_setId_fkey" FOREIGN KEY ("setId") REFERENCES "RelicSet" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SetMember_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "RelicType" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SetMember_varietyId_fkey" FOREIGN KEY ("varietyId") REFERENCES "RelicVariety" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "Relic" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "typeId" INTEGER,
    "varietyId" INTEGER,
    "indexNumber" INTEGER,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "customDescription" TEXT,
    "lore" TEXT,
    "customImageUrl" TEXT,
    "backgroundPattern" TEXT,
    "patternColor" TEXT,
    "acquisitionDate" DATETIME,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "linkedRelicIds" TEXT,
    "imageUrl" TEXT,
    "event" TEXT,
    "ownerId" TEXT,
    "ownerEmail" TEXT,
    "ownerDeviceId" TEXT,
    "lastSeen" DATETIME,
    "resetPending" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Relic_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "RelicType" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Relic_varietyId_fkey" FOREIGN KEY ("varietyId") REFERENCES "RelicVariety" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Relic_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "RelicSet_name_key" ON "RelicSet"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "SetMember_setId_typeId_varietyId_key" ON "SetMember"("setId", "typeId", "varietyId");
CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "deviceId" TEXT,
    "pinHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");
