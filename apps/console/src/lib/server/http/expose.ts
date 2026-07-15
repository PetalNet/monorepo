import { json, type RequestHandler } from "@sveltejs/kit";

const assertJson = (value: unknown) => {
	JSON.stringify(value);
	return value;
};

export const expose = <T>(operation: () => Promise<T>): RequestHandler => async () =>
	json(assertJson(await operation()));
