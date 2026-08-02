import { PublicEnvConfigLayer } from "$lib/config";
import { ConsoleServiceLive } from "$lib/server/console/service";
import { ConsoleDomainLive } from "$lib/server/domain/service";
import { Layer } from "effect";

export const ServerLayer = Layer.orDie(
	Layer.mergeAll(ConsoleServiceLive, ConsoleDomainLive, PublicEnvConfigLayer),
);
