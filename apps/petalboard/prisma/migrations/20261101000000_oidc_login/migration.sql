ALTER TABLE "User" ADD COLUMN "oidcSubject" TEXT;
CREATE UNIQUE INDEX "User_oidcSubject_key" ON "User"("oidcSubject");
-- password-era sessions must not outlive the move to group-gated OIDC login, so every host signs in again through Authentik.
DELETE FROM "Session";
