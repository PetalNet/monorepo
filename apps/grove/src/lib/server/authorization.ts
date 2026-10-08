import { Data } from "effect";

export class AuthenticationRequired extends Data.TaggedError("AuthenticationRequired") {
	override get message() {
		return "Authentication required";
	}
}
