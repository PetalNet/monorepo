import type { Attachment } from "svelte/attachments";

export const createCommandSubmission = () => {
	let id = crypto.randomUUID();
	let submittedPayload: string | undefined;

	const prepare = (data: FormData, commandFieldName: string) => {
		const payload = JSON.stringify(
			[...data.entries()]
				.filter(([name]) => name !== commandFieldName)
				.toSorted(([left], [right]) => left.localeCompare(right)),
		);

		if (submittedPayload !== undefined && payload !== submittedPayload) {
			id = crypto.randomUUID();
		}

		submittedPayload = payload;
		data.set(commandFieldName, id);
	};

	return {
		get id() {
			return id;
		},
		prepare,
		complete() {
			id = crypto.randomUUID();
			submittedPayload = undefined;
		},
		attach:
			(commandFieldName: string): Attachment<HTMLFormElement> =>
			(element) => {
				// FormData is captured before the remote form's enhance callback runs.
				const onFormData = (event: FormDataEvent) => {
					prepare(event.formData, commandFieldName);
				};

				element.addEventListener("formdata", onFormData);

				return () => {
					element.removeEventListener("formdata", onFormData);
				};
			},
	};
};
