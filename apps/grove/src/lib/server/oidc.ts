import { genericOAuth } from "better-auth/plugins/generic-oauth";

export const GROVE_OIDC_PROVIDER_ID = "grove-oidc";

export interface GroveOidcConfig {
	readonly issuer: string;
	readonly clientId: string;
	readonly clientSecret: string;
	readonly callbackOrigin: string;
}

const withoutTrailingSlash = (value: string) => value.replace(/\/+$/, "");

export const oidcDiscoveryUrl = (issuer: string) =>
	`${withoutTrailingSlash(issuer)}/.well-known/openid-configuration`;

export const oidcCallbackUrl = (origin: string) =>
	`${withoutTrailingSlash(origin)}/api/auth/callback/${GROVE_OIDC_PROVIDER_ID}`;

export const groveOidc = (config: GroveOidcConfig) => {
	const plugin = genericOAuth({
		config: [
			{
				providerId: GROVE_OIDC_PROVIDER_ID,
				name: "Grove identity provider",
				discoveryUrl: oidcDiscoveryUrl(config.issuer),
				accountIssuer: config.issuer,
				clientId: config.clientId,
				clientSecret: config.clientSecret,
				redirectURI: oidcCallbackUrl(config.callbackOrigin),
				responseType: "code",
				pkce: true,
				scopes: ["openid", "profile", "email"],
				requireEmailVerification: true,
				mapProfileToUser: (profile) => ({ emailVerified: profile.emailVerified === true }),
			},
		],
	});

	return {
		...plugin,
		async init(context: Parameters<NonNullable<typeof plugin.init>>[0]) {
			const initialized = await plugin.init?.(context);
			const provider = initialized?.context?.socialProviders.find(
				(candidate) => candidate.id === GROVE_OIDC_PROVIDER_ID,
			);
			if (
				!provider ||
				provider.issuer !== config.issuer ||
				!provider.idToken ||
				provider.requiresIdTokenNonce !== true
			)
				throw new Error("Grove OIDC discovery did not match the pinned issuer and nonce policy");

			const getUserInfo = provider.getUserInfo.bind(provider);
			provider.getUserInfo = async (tokens) => {
				const result = await getUserInfo(tokens);
				return result?.user.emailVerified === true ? result : null;
			};

			const validateAuthorizationCode = provider.validateAuthorizationCode.bind(provider);
			provider.validateAuthorizationCode = async (data) => {
				const tokens = await validateAuthorizationCode(data);
				if (!tokens?.idToken)
					throw new Error("Grove OIDC token response omitted the required ID token");
				return tokens;
			};
			return initialized;
		},
	};
};
