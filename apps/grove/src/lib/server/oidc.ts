import type { AuthContext } from "better-auth";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { decodeJwt } from "jose";

export const GROVE_OIDC_PROVIDER_ID = "grove-oidc";

export interface GroveOidcConfig {
	readonly issuer: string;
	readonly clientId: string;
	readonly clientSecret: string;
	readonly callbackOrigin: string;
}

const withoutTrailingSlash = (value: string) => value.replace(/\/+$/, "");

const oidcDiscoveryUrl = (issuer: string) =>
	`${withoutTrailingSlash(issuer)}/.well-known/openid-configuration`;

const oidcCallbackUrl = (origin: string) =>
	`${withoutTrailingSlash(origin)}/api/auth/callback/${GROVE_OIDC_PROVIDER_ID}`;

export const groveOidc = (config: GroveOidcConfig) => {
	const issuer = withoutTrailingSlash(config.issuer);
	const plugin = genericOAuth({
		config: [
			{
				providerId: GROVE_OIDC_PROVIDER_ID,
				name: "Grove identity provider",
				discoveryUrl: oidcDiscoveryUrl(issuer),
				accountIssuer: issuer,
				clientId: config.clientId,
				clientSecret: config.clientSecret,
				redirectURI: oidcCallbackUrl(config.callbackOrigin),
				responseType: "code",
				pkce: true,
				scopes: ["openid", "profile", "email"],
				requireEmailVerification: true,
				mapProfileToUser: (profile) => ({ emailVerified: profile.emailVerified }),
			},
		],
	});

	return {
		...plugin,
		async init(context: AuthContext) {
			const initialized = await plugin.init(context);
			const provider = initialized.context.socialProviders.find(
				(candidate) => candidate.id === GROVE_OIDC_PROVIDER_ID,
			);
			if (
				!provider?.idToken ||
				provider.issuer !== issuer ||
				provider.requiresIdTokenNonce !== true
			)
				throw new Error("Grove OIDC discovery did not match the pinned issuer and nonce policy");

			const getUserInfo = provider.getUserInfo.bind(provider);
			provider.getUserInfo = async (tokens) => {
				const result = await getUserInfo(tokens);
				if (!result?.user.emailVerified || !tokens.idToken) return null;
				const claims = decodeJwt(tokens.idToken);
				const audience = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
				if (
					typeof claims.sub !== "string" ||
					claims.sub.length === 0 ||
					typeof claims.exp !== "number" ||
					typeof claims.iat !== "number" ||
					(claims.azp !== undefined && claims.azp !== config.clientId) ||
					(audience.length > 1 && claims.azp !== config.clientId)
				)
					return null;
				return result;
			};

			const validateAuthorizationCode = provider.validateAuthorizationCode.bind(provider);
			provider.validateAuthorizationCode = async (data) => {
				const tokens = await validateAuthorizationCode(data);
				if (tokens === null)
					throw new Error("Grove OIDC token response omitted the required ID token");
				if (!tokens.idToken)
					throw new Error("Grove OIDC token response omitted the required ID token");
				return tokens;
			};
			return initialized;
		},
	};
};
