-- AlterTable
ALTER TABLE "Event" ADD COLUMN "spotifyPlaylistId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "spotifyAccessToken" TEXT;
ALTER TABLE "User" ADD COLUMN "spotifyRefreshToken" TEXT;
ALTER TABLE "User" ADD COLUMN "spotifyTokenExpiry" DATETIME;
