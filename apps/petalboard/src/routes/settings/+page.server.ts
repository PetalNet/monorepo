import { redirect, fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { prisma } from "$lib/server/prisma";
import { hashPassword, verifyPassword } from "$lib/server/auth";
import { z } from "zod";

const updateProfileSchema = z.object({
  email: z.string().trim().email("Enter a valid email").max(160),
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(100),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(100),
  confirmPassword: z.string().min(1, "Please confirm your password"),
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
    const email = data.get("email")?.toString() || "";

    // Validate with zod
    const result = updateProfileSchema.safeParse({ name, email });

    if (!result.success) {
      const errors: Record<string, string[]> = {};
      result.error.issues.forEach((err) => {
        const field = err.path[0] as string;
        if (!errors[field]) errors[field] = [];
        errors[field].push(err.message);
      });

      return fail(400, {
        type: "updateProfile",
        errors,
        values: { name, email },
      });
    }

    // Check if email is already taken
    if (email !== locals.user.email) {
      const existingUser = await prisma.user.findUnique({
        where: { email },
      });
      if (existingUser) {
        return fail(400, {
          type: "updateProfile",
          errors: { email: ["Email is already in use"] },
          values: { name, email },
        });
      }
    }

    try {
      await prisma.user.update({
        where: { id: locals.user.id },
        data: {
          name,
          email,
        },
      });

      return {
        type: "updateProfile",
        success: true,
        message: "Profile updated successfully",
      };
    } catch (error) {
      return fail(500, {
        type: "updateProfile",
        message: "Failed to update profile",
      });
    }
  },

  changePassword: async ({ locals, request }) => {
    if (!locals.user) {
      throw redirect(302, "/login");
    }

    const data = await request.formData();
    const currentPassword = data.get("currentPassword")?.toString() || "";
    const newPassword = data.get("newPassword")?.toString() || "";
    const confirmPassword = data.get("confirmPassword")?.toString() || "";

    // Validate with zod
    const result = changePasswordSchema.safeParse({
      currentPassword,
      newPassword,
      confirmPassword,
    });

    if (!result.success) {
      const errors: Record<string, string[]> = {};
      result.error.issues.forEach((err) => {
        const field = err.path[0] as string;
        if (!errors[field]) errors[field] = [];
        errors[field].push(err.message);
      });

      return fail(400, {
        type: "changePassword",
        errors,
      });
    }

    // Verify current password
    const user = await prisma.user.findUnique({
      where: { id: locals.user.id },
    });

    if (!user) {
      return fail(404, {
        type: "changePassword",
        message: "User not found",
      });
    }

    const valid = await verifyPassword(currentPassword, user.passwordHash);
    if (!valid) {
      return fail(400, {
        type: "changePassword",
        errors: { currentPassword: ["Current password is incorrect"] },
      });
    }

    // Verify passwords match
    if (newPassword !== confirmPassword) {
      return fail(400, {
        type: "changePassword",
        errors: { confirmPassword: ["Passwords do not match"] },
      });
    }

    try {
      const passwordHash = await hashPassword(newPassword);
      await prisma.user.update({
        where: { id: locals.user.id },
        data: { passwordHash },
      });

      return {
        type: "changePassword",
        success: true,
        message: "Password changed successfully",
      };
    } catch (error) {
      return fail(500, {
        type: "changePassword",
        message: "Failed to change password",
      });
    }
  },

  deleteAccount: async ({ locals, request, cookies }) => {
    if (!locals.user) {
      throw redirect(302, "/login");
    }

    const data = await request.formData();
    const password = data.get("password")?.toString() || "";

    // Verify password
    const user = await prisma.user.findUnique({
      where: { id: locals.user.id },
    });

    if (!user) {
      return fail(404, {
        type: "deleteAccount",
        message: "User not found",
      });
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return fail(400, {
        type: "deleteAccount",
        errors: { password: ["Password is incorrect"] },
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
      const result = await prisma.user.update({
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
