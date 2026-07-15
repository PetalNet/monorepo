export const isUnauthenticatedRoute = (pathname: string) =>
	pathname === "/login" || pathname.startsWith("/api/auth/");
