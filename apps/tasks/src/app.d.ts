declare namespace App {
	interface Locals {
		/** The Authentik username; unset on the SSO-exempt paths. */
		user?: string;
	}
}
