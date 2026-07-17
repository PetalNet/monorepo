import { ConsoleServiceLive } from "$lib/server/console/service";
import { makeDatabaseLayer } from "$lib/server/db/client";
import { ConsoleDomainLive } from "$lib/server/domain/service";
import { Layer } from "effect";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://build.invalid/console";

export const ServerLayer = Layer.orDie(
	Layer.mergeAll(ConsoleServiceLive, ConsoleDomainLive, makeDatabaseLayer(databaseUrl)),
);
