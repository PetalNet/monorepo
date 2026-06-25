import { Prisma } from "@prisma/client";
import { customAlphabet } from "nanoid";
import { fail, redirect } from "@sveltejs/kit";

import prisma from "$lib/server/prisma";
import { eventSchema } from "$lib/server/validation";
import { parseLocalDateTimeInTimezone } from "$lib/utils/timezones";

const publicId = customAlphabet("346789ABCDEFGHJKLMNPQRTUVWXY", 8);
const manageId = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 32);

export const load = async ({ locals }) => {
  if (!locals.user) {
    throw redirect(303, "/login");
  }
};

export const actions = {
  default: async ({ request, url, locals }) => {
    if (!locals.user) {
      throw redirect(303, "/login");
    }

    const formData = await request.formData();
    const raw = Object.fromEntries(formData) as Record<string, string>;
    const parsed = eventSchema.safeParse(raw);

    if (!parsed.success) {
      return fail(400, {
        success: false,
        errors: parsed.error.flatten().fieldErrors,
        values: raw,
      });
    }

    const {
      title,
      date,
      endDate,
      timezone,
      rsvpLimit,
      location,
      description,
      primaryColor,
      secondaryColor,
      backgroundImage,
      emoji,
    } = parsed.data;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const publicCode = publicId();
      const manageToken = manageId();

      try {
        const event = await prisma.event.create({
          data: {
            title,
            date: parseLocalDateTimeInTimezone(date, timezone),
            endDate: endDate
              ? parseLocalDateTimeInTimezone(endDate, timezone)
              : null,
            timezone,
            rsvpLimit: rsvpLimit ?? null,
            location: location ?? null,
            description: description ?? null,
            primaryColor: primaryColor ?? null,
            secondaryColor: secondaryColor ?? null,
            backgroundImage: backgroundImage ?? null,
            emoji: emoji ?? null,
            publicCode,
            manageToken,
            userId: locals.user.id,
          },
        });

        // Successfully created, redirect to the management page
        throw redirect(303, `/event/manage/${event.manageToken}?new`);
      } catch (error) {
        // Prisma duplicate key error - try again with a new code
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          continue;
        }

        // Not a Prisma error - re-throw (this includes redirects)
        throw error;
      }
    }

    // Failed after all attempts
    return fail(500, {
      success: false,
      message: "Unable to create event. Please try again.",
      values: raw,
    });
  },
};
