-- CreateTable
CREATE TABLE "RsvpGuest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "rsvpId" TEXT NOT NULL,
    CONSTRAINT "RsvpGuest_rsvpId_fkey" FOREIGN KEY ("rsvpId") REFERENCES "Rsvp" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "RsvpGuest_rsvpId_idx" ON "RsvpGuest"("rsvpId");
