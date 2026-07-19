import { createAdapterFactory } from "better-auth/adapters";
type AdapterFactory = ReturnType<typeof createAdapterFactory> & {
	close: () => Promise<void>;
};
export declare const createEffectQbAdapter: (databaseUrl: string) => AdapterFactory;
export {};
//# sourceMappingURL=index.d.ts.map
