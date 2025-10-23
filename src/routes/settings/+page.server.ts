import { fail, redirect } from "@sveltejs/kit";
import type { PageServerLoad, Actions } from "./$types";
import { prisma } from "$lib/server/db";
import { deleteSession } from "$lib/server/auth";
import bcrypt from "bcrypt";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) {
    throw redirect(303, "/auth/login");
  }

  return {
    user: locals.user,
  };
};

export const actions: Actions = {
  updateName: async ({ locals, request }) => {
    if (!locals.user) {
      return fail(401, { error: "Not authenticated" });
    }

    const data = await request.formData();
    const name = data.get("name") as string;

    if (!name || name.trim().length === 0) {
      return fail(400, { error: "Name is required" });
    }

    if (name.trim().length > 100) {
      return fail(400, { error: "Name is too long" });
    }

    try {
      await prisma.user.update({
        where: { id: locals.user.id },
        data: { name: name.trim() },
      });

      return { success: true, message: "Name updated successfully" };
    } catch (error) {
      console.error("Error updating name:", error);
      return fail(500, { error: "Failed to update name" });
    }
  },

  updateEmail: async ({ locals, request }) => {
    if (!locals.user) {
      return fail(401, { error: "Not authenticated" });
    }

    const data = await request.formData();
    const email = data.get("email") as string;
    const password = data.get("password") as string;

    if (!email || !password) {
      return fail(400, { error: "Email and password are required" });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return fail(400, { error: "Invalid email format" });
    }

    try {
      // Verify current password
      const user = await prisma.user.findUnique({
        where: { id: locals.user.id },
      });

      if (!user) {
        return fail(404, { error: "User not found" });
      }

      const validPassword = await bcrypt.compare(password, user.passwordHash);

      if (!validPassword) {
        return fail(400, { error: "Incorrect password" });
      }

      // Check if email is already taken
      const existingUser = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
      });

      if (existingUser && existingUser.id !== locals.user.id) {
        return fail(400, { error: "Email is already in use" });
      }

      // Update email
      await prisma.user.update({
        where: { id: locals.user.id },
        data: { email: email.toLowerCase() },
      });

      return { success: true, message: "Email updated successfully" };
    } catch (error) {
      console.error("Error updating email:", error);
      return fail(500, { error: "Failed to update email" });
    }
  },

  updatePassword: async ({ locals, request }) => {
    if (!locals.user) {
      return fail(401, { error: "Not authenticated" });
    }

    const data = await request.formData();
    const currentPassword = data.get("currentPassword") as string;
    const newPassword = data.get("newPassword") as string;
    const confirmPassword = data.get("confirmPassword") as string;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return fail(400, { error: "All password fields are required" });
    }

    if (newPassword !== confirmPassword) {
      return fail(400, { error: "New passwords do not match" });
    }

    if (newPassword.length < 8) {
      return fail(400, { error: "New password must be at least 8 characters" });
    }

    try {
      // Verify current password
      const user = await prisma.user.findUnique({
        where: { id: locals.user.id },
      });

      if (!user) {
        return fail(404, { error: "User not found" });
      }

      const validPassword = await bcrypt.compare(
        currentPassword,
        user.passwordHash
      );

      if (!validPassword) {
        return fail(400, { error: "Current password is incorrect" });
      }

      // Hash new password
      const passwordHash = await bcrypt.hash(newPassword, 10);

      // Update password
      await prisma.user.update({
        where: { id: locals.user.id },
        data: { passwordHash },
      });

      return { success: true, message: "Password updated successfully" };
    } catch (error) {
      console.error("Error updating password:", error);
      return fail(500, { error: "Failed to update password" });
    }
  },

  deleteAccount: async ({ locals, cookies }) => {
    if (!locals.user) {
      return fail(401, { error: "Not authenticated" });
    }

    try {
      // Delete all events hosted by the user (cascades to all related data)
      await prisma.event.deleteMany({
        where: { hostId: locals.user.id },
      });

      // Delete all user sessions
      await prisma.session.deleteMany({
        where: { userId: locals.user.id },
      });

      // Delete the user (this will cascade delete groupMembers)
      await prisma.user.delete({
        where: { id: locals.user.id },
      });

      // Clear session cookie
      cookies.delete("session", { path: "/" });

      // Redirect to landing page
      throw redirect(303, "/");
    } catch (error) {
      console.error("Error deleting account:", error);
      return fail(500, { error: "Failed to delete account" });
    }
  },
};
