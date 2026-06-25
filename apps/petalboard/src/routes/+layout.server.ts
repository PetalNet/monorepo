export const load = async ({ locals }) => {
  return {
    user: locals.user
      ? {
          id: locals.user.id,
          email: locals.user.email,
          name: locals.user.name,
        }
      : null,
  };
};
