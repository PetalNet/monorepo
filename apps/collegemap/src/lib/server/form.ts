/**
 * Read a text field out of a submitted form.
 *
 * `FormData.get` returns `string | File | null`: a client is free to send a file part for any field
 * name, and `File`'s default stringification is `[object File]` — which would sail straight into a
 * name, a password or a `parseFloat`. Anything that is not text is therefore treated as absent.
 */
export function formText(data: FormData, field: string): string | undefined {
	const value = data.get(field);
	return typeof value === "string" ? value : undefined;
}
