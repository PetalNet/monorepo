import type { Services } from "./substrate";

const servicesKey = Symbol.for("petalnet.console.services");
const sharedGlobal = globalThis as typeof globalThis & Record<symbol, unknown>;

export const getSharedConsoleServices = (): Promise<Services> | undefined => {
	const value = sharedGlobal[servicesKey];
	return value instanceof Promise ? (value as Promise<Services>) : undefined;
};

export const setSharedConsoleServices = (services: Promise<Services>): void => {
	sharedGlobal[servicesKey] = services;
};

export const clearSharedConsoleServices = (): void => {
	delete sharedGlobal[servicesKey];
};
