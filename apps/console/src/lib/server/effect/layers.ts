import { Layer } from "effect";
import { makeDatabaseLayer } from "$lib/server/db/client";
import { ConsoleServiceLive } from "./console-service";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://build.invalid/console";

export const ServerLayer = Layer.orDie(
	Layer.mergeAll(ConsoleServiceLive, makeDatabaseLayer(databaseUrl)),
);
