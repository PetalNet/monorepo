import type { BetterAuthOptions, Session, User } from "better-auth";
import { isAPIError } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { Context, Data, Effect, Layer } from "effect";

export class BetterAuthApiError extends Data.TaggedError("BetterAuthApiError")<{
	readonly statusCode: number;
	readonly code: string | undefined;
	readonly message: string;
	readonly headers: Headers | undefined;
	readonly cause: unknown;
}> {}

export class BetterAuthInitializationError extends Data.TaggedError(
	"BetterAuthInitializationError",
)<{
	readonly cause: unknown;
}> {
	override get message() {
		return "Better Auth could not initialize";
	}
}

interface BetterAuthShape {
	readonly getSession: (
		headers: Headers,
	) => Effect.Effect<{ readonly session: Session; readonly user: User } | null, BetterAuthApiError>;
	readonly signInSocial: (
		headers: Headers,
		body: { readonly provider: string; readonly callbackURL: string },
	) => Effect.Effect<Headers, BetterAuthApiError>;
	readonly signOut: (headers: Headers) => Effect.Effect<Headers, BetterAuthApiError>;
	readonly handler: (request: Request) => Effect.Effect<Response>;
}

export class BetterAuth extends Context.Service<BetterAuth, BetterAuthShape>()(
	"better-auth/BetterAuth",
) {}

const apiCall = <A>(call: () => Promise<A>): Effect.Effect<A, BetterAuthApiError> =>
	Effect.tryPromise({
		try: call,
		catch: (cause) => {
			if (!isAPIError(cause)) {
				throw cause;
			}

			return new BetterAuthApiError({
				statusCode: cause.statusCode,
				code: cause.body?.code,
				message: cause.message,
				headers: new Headers(cause.headers),
				cause,
			});
		},
	});

export const BetterAuthLayer = (options: BetterAuthOptions) =>
	Layer.effect(
		BetterAuth,
		Effect.gen(function* () {
			const auth = betterAuth(options);

			yield* Effect.tryPromise({
				try: () => auth.$context,
				catch: (cause) => new BetterAuthInitializationError({ cause }),
			});

			return BetterAuth.of({
				getSession: (headers) => apiCall(() => auth.api.getSession({ headers })),
				signInSocial: (headers, body) =>
					apiCall(() =>
						auth.api.signInSocial({
							body,
							headers,
							returnHeaders: true,
						}),
					).pipe(Effect.map((result) => result.headers)),
				signOut: (headers) =>
					apiCall(() => auth.api.signOut({ headers, returnHeaders: true })).pipe(
						Effect.map((result) => result.headers),
					),
				handler: (request) => Effect.promise(() => auth.handler(request)),
			});
		}),
	);
