export class AuthenticationRequired extends Error {
	readonly _tag = "AuthenticationRequired";

	constructor() {
		super("Authentication required");
	}
}
