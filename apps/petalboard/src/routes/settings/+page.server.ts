import { prisma } from "$lib/server/prisma";
import { redirect, fail } from "@sveltejs/kit";
import { z } from "zod";

import type { Actions, PageServerLoad } from "./$types";

const updateProfileSchema = z.object({
	name: z.string().trim().min(2, "Name must be at least 2 characters").max(100),
});

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		throw redirect(302, "/login");
	}

	// Fetch full user data including Spotify fields
	const user = await prisma.user.findUnique({
		where: { id: locals.user.id },
		select: {
			id: true,
			email: true,
			name: true,
			emailVerified: true,
			spotifyAccessToken: true,
			createdAt: true,
		},
	});

	if (!user) {
		throw redirect(302, "/login");
	}

	return {
		user,
	};
};

export const actions = {
	updateProfile: async ({ locals, request }) => {
		if (!locals.user) {
			throw redirect(302, "/login");
		}

		const data = await request.formData();
		const name = data.get("name")?.toString() || "";

		const result = updateProfileSchema.safeParse({ name });

		if (!result.success) {
			const errors: Record<string, string[]> = {};

			result.error.issues.forEach((err) => {
				const field = err.path[0] as string;

				if (!errors[field]) {
					errors[field] = [];
				}

				errors[field].push(err.message);
			});

			return fail(400, {
				type: "updateProfile",
				errors,
				values: { name },
			});
		}

		try {
			await prisma.user.update({
				where: { id: locals.user.id },
				data: { name },
			});

			return {
				type: "updateProfile",
				success: true,
				message: "Profile updated successfully",
			};
		} catch {
			return fail(500, {
				type: "updateProfile",
				message: "Failed to update profile",
			});
		}
	},

	deleteAccount: async ({ locals, request, cookies }) => {
		if (!locals.user) {
			throw redirect(302, "/login");
		}

		const data = await request.formData();
		const email = data.get("email")?.toString() || "";

		const user = await prisma.user.findUnique({
			where: { id: locals.user.id },
		});

		if (!user) {
			return fail(404, {
				type: "deleteAccount",
				message: "User not found",
			});
		}

		if (email !== user.email) {
			return fail(400, {
				type: "deleteAccount",
				errors: { email: ["Enter your account email exactly to confirm"] },
			});
		}

		try {
			// Delete user (cascade will delete sessions and events)
			await prisma.user.delete({
				where: { id: locals.user.id },
			});

			// Clear session cookie
			cookies.delete("session", { path: "/" });

			throw redirect(302, "/");
		} catch (error: any) {
			if (error?.status === 302) {
				throw error;
			}

			return fail(500, {
				type: "deleteAccount",
				message: "Failed to delete account",
			});
		}
	},

	disconnectSpotify: async ({ locals }) => {
		if (!locals.user) {
			throw redirect(302, "/login");
		}

		console.log("=== DISCONNECT SPOTIFY called for user:", locals.user.id);

		try {
			await prisma.user.update({
				where: { id: locals.user.id },
				data: {
					spotifyAccessToken: null,
					spotifyRefreshToken: null,
					spotifyTokenExpiry: null,
				},
			});

			console.log("=== DISCONNECT SPOTIFY completed");

			return {
				type: "disconnectSpotify",
				success: true,
				message: "Spotify disconnected successfully",
			};
		} catch (error) {
			console.error("=== DISCONNECT SPOTIFY error:", error);

			return fail(500, {
				type: "disconnectSpotify",
				message: "Failed to disconnect Spotify",
			});
		}
	},
} satisfies Actions;
