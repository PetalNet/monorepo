import { fail, redirect } from "@sveltejs/kit";
import { Prisma } from "@prisma/client";
import { customAlphabet } from "nanoid";
import prisma from "$lib/server/prisma";
import { hashPassword, createSession } from "$lib/server/auth";
import { registerSchema } from "$lib/server/validation";
import { sendVerificationEmail } from "$lib/server/email";

const verificationToken = customAlphabet(
  "abcdefghijklmnopqrstuvwxyz0123456789",
  32
);

export const load = async ({ locals }) => {
  if (locals.user) {
    throw redirect(303, "/dashboard");
  }
};

export const actions = {
  default: async ({ request, cookies }) => {
    const formData = await request.formData();
    const raw = Object.fromEntries(formData) as Record<string, string>;
    const parsed = registerSchema.safeParse(raw);

    if (!parsed.success) {
      return fail(400, {
        errors: parsed.error.flatten().fieldErrors,
        values: { email: raw.email, name: raw.name },
      });
    }

    const { email, password, name } = parsed.data;
    const passwordHash = hashPassword(password);
    const token = verificationToken();

    try {
      const user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          name,
          verificationToken: token,
          emailVerified: false,
        },
      });

      // Send verification email
      try {
        await sendVerificationEmail(email, name, token);
      } catch (emailError) {
        console.error("Failed to send verification email:", emailError);
        // Delete the user if we can't send the email
        await prisma.user.delete({ where: { id: user.id } });
        return fail(500, {
          message:
            "Unable to send verification email. Please try again or contact support.",
          values: { email, name },
        });
      }

      // Don't create session yet - user must verify email first
      return {
        success: true,
        message:
          "Account created! Please check your email to verify your account.",
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return fail(400, {
          errors: { email: ["This email is already registered"] },
          values: { email, name },
        });
      }

      console.error("Registration error:", error);
      return fail(500, {
        message: "Unable to create account. Please try again.",
        values: { email, name },
      });
    }
  },
};
