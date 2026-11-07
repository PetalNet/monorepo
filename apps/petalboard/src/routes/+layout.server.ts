export const load = async ({ locals }) => ({
	user: locals.user
		? {
				id: locals.user.id,
				email: locals.user.email,
				name: locals.user.name,
			}
		: null,
});
