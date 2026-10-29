import { fail, error } from "@sveltejs/kit";
import { z } from "zod";

import prisma from "$lib/server/prisma";
import { hashPin, verifyPin } from "$lib/server/security";
import { rsvpSchema } from "$lib/server/validation";
import {
  refreshAccessToken,
  createPlaylist,
  replacePlaylistTracks,
  getSpotifyProfile,
} from "$lib/server/spotify";
import type { SpotifyTrack } from "$lib/server/spotify";

export const load = async ({ params, locals }) => {
  const event = await prisma.event.findUnique({
    where: { publicCode: params.code },
    select: {
      id: true,
      userId: true,
      title: true,
      description: true,
      date: true,
      endDate: true,
      timezone: true,
      location: true,
      publicCode: true,
      rsvpLimit: true,
      theme: true,
      primaryColor: true,
      secondaryColor: true,
      backgroundImage: true,
      emoji: true,
      questions: {
        orderBy: { order: "asc" },
        select: {
          id: true,
          label: true,
          description: true,
          type: true,
          options: true,
          quantity: true,
          required: true,
          isPublic: true,
          spotifyPlaylistId: true,
          songsPerUser: true,
          responses: {
            select: {
              id: true,
              value: true,
              rsvp: {
                select: {
                  name: true,
                  status: true,
                },
              },
            },
          },
        },
      },
      rsvps: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          email: true,
          status: true,
          guestCount: true,
          createdAt: true,
          responses: {
            select: {
              id: true,
              value: true,
              question: { select: { id: true, label: true, type: true } },
            },
          },
        },
      },
    },
  });

  if (!event) {
    throw error(404, "Event not found");
  }

  // Check if current user is the event owner
  const isOwner = locals.user?.id === event.userId;

  const rsvpCount = event.rsvps.length;
  const totalGuests = event.rsvps.reduce((sum, r) => sum + r.guestCount, 0);

  return {
    event: {
      id: event.id,
      title: event.title,
      description: event.description,
      date: event.date,
      endDate: event.endDate,
      timezone: event.timezone,
      location: event.location,
      publicCode: event.publicCode,
      rsvpLimit: event.rsvpLimit,
      rsvpCount,
      totalGuests,
      theme: event.theme,
      primaryColor: event.primaryColor,
      secondaryColor: event.secondaryColor,
      backgroundImage: event.backgroundImage,
      emoji: event.emoji,
      questions: event.questions.map((question) => ({
        id: question.id,
        label: question.label,
        description: question.description,
        type: question.type,
        options: question.options ? JSON.parse(question.options) : null,
        quantity: question.quantity,
        required: question.required,
        isPublic: question.isPublic,
        spotifyPlaylistId: question.spotifyPlaylistId,
        songsPerUser: question.songsPerUser,
        responseCount: question.responses.length,
        publicResponses: question.isPublic
          ? question.responses.map((r) => ({
              name: r.rsvp.name,
              value: r.value,
              status: r.rsvp.status,
            }))
          : [],
      })),
    },
    isOwner,
    rsvps: event.rsvps.map((rsvp) => ({
      id: rsvp.id,
      name: rsvp.name,
      email: isOwner ? rsvp.email : null, // Only show email to owner
      status: rsvp.status,
      guestCount: rsvp.guestCount,
      createdAt: rsvp.createdAt,
      responses: rsvp.responses.map((r) => ({
        questionId: r.question.id,
        questionLabel: r.question.label,
        questionType: r.question.type,
        answer: r.value,
      })),
    })),
  } as const;
};

function parseSpotifySelection(raw: string | null | undefined): SpotifyTrack[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item): item is SpotifyTrack =>
          typeof item === "object" &&
          item !== null &&
          typeof item.uri === "string"
      );
    }
    if (typeof parsed === "object" && parsed !== null && "uri" in parsed) {
      return [parsed as SpotifyTrack];
    }
  } catch (error) {
    console.warn("Failed to parse Spotify response value", error);
  }

  return [];
}

async function getSpotifyAccessTokenForUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      spotifyAccessToken: true,
      spotifyRefreshToken: true,
      spotifyTokenExpiry: true,
    },
  });

  if (!user?.spotifyAccessToken || !user.spotifyRefreshToken) {
    return null;
  }

  let accessToken = user.spotifyAccessToken;
  let refreshToken = user.spotifyRefreshToken;

  if (user.spotifyTokenExpiry && new Date() >= user.spotifyTokenExpiry) {
    try {
      const refreshed = await refreshAccessToken(user.spotifyRefreshToken);
      accessToken = refreshed.access_token;
      refreshToken = refreshed.refresh_token ?? refreshToken;

      await prisma.user.update({
        where: { id: userId },
        data: {
          spotifyAccessToken: accessToken,
          spotifyRefreshToken: refreshToken,
          spotifyTokenExpiry: new Date(
            Date.now() + refreshed.expires_in * 1000
          ),
        },
      });
    } catch (error) {
      console.error("Failed to refresh Spotify access token", error);
      return null;
    }
  }

  return { accessToken, refreshToken };
}

async function syncSpotifyPlaylists(eventId: string) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: {
      title: true,
      user: { select: { id: true, name: true } },
      questions: {
        where: { type: "spotify_playlist" },
        select: {
          id: true,
          label: true,
          spotifyPlaylistId: true,
          responses: {
            orderBy: { createdAt: "asc" },
            select: { value: true, createdAt: true },
          },
        },
      },
    },
  });

  if (!event || event.questions.length === 0) {
    return;
  }

  const spotifyAuth = await getSpotifyAccessTokenForUser(event.user.id);
  if (!spotifyAuth) {
    return;
  }

  let spotifyUserId: string | null = null;

  for (const question of event.questions) {
    try {
      const collected = question.responses.flatMap((response) => {
        const tracks = parseSpotifySelection(response.value);
        const baseTime = new Date(response.createdAt).getTime();
        return tracks.map((track, index) => ({
          uri: track.uri,
          order: baseTime + index / 10,
        }));
      });

      collected.sort((a, b) => a.order - b.order);

      const seen = new Set<string>();
      const desiredUris: string[] = [];
      for (const item of collected) {
        if (!item.uri || seen.has(item.uri)) continue;
        seen.add(item.uri);
        desiredUris.push(item.uri);
      }

      if (!question.spotifyPlaylistId) {
        if (desiredUris.length === 0) {
          continue;
        }

        if (!spotifyUserId) {
          const profile = await getSpotifyProfile(spotifyAuth.accessToken);
          spotifyUserId = profile.id;
        }

        if (spotifyUserId) {
          const playlist = await createPlaylist(
            spotifyUserId,
            `${event.title} - ${question.label}`,
            "Automatically collected tracks from PetalBoard RSVP responses.",
            spotifyAuth.accessToken
          );

          await prisma.question.update({
            where: { id: question.id },
            data: { spotifyPlaylistId: playlist.id },
          });

          question.spotifyPlaylistId = playlist.id;
        }
      }

      if (question.spotifyPlaylistId) {
        await replacePlaylistTracks(
          question.spotifyPlaylistId,
          desiredUris,
          spotifyAuth.accessToken
        );
      }
    } catch (error) {
      console.error(
        `Failed to sync Spotify playlist for question ${question.id}`,
        error
      );
    }
  }
}

export const actions = {
  rsvp: async ({ request, params }) => {
    const event = await prisma.event.findUnique({
      where: { publicCode: params.code },
      select: {
        id: true,
        rsvpLimit: true,
        _count: { select: { rsvps: true } },
        questions: {
          select: {
            id: true,
            label: true,
            required: true,
            type: true,
            quantity: true,
            songsPerUser: true,
            spotifyPlaylistId: true,
            responses: {
              select: {
                id: true,
              },
            },
          },
        },
      },
    });

    if (!event) {
      throw error(404, "Event not found");
    }

    const formData = await request.formData();

    // Parse form data and extract responses
    const responses: Record<string, string> = {};
    const raw: Record<string, string> = {};

    for (const [key, value] of formData.entries()) {
      if (key.startsWith("response_")) {
        const questionId = key.replace("response_", "");
        responses[questionId] = value as string;
      } else {
        raw[key] = value as string;
      }
    }

    // Add responses to raw data for validation
    const dataToValidate = { ...raw, responses };
    const parsed = rsvpSchema.safeParse(dataToValidate);

    if (!parsed.success) {
      return fail(400, {
        success: false,
        errors: parsed.error.flatten().fieldErrors,
        values: raw,
      });
    }

    const { name, email, pin, status, guestCount } = parsed.data;

    // Check RSVP limit (using sum of guest counts)
    if (event.rsvpLimit) {
      const totalGuests = await prisma.rsvp.aggregate({
        where: { eventId: event.id },
        _sum: { guestCount: true },
      });
      const currentTotal = totalGuests._sum.guestCount ?? 0;
      if (currentTotal + guestCount > event.rsvpLimit) {
        return fail(400, {
          success: false,
          message:
            guestCount > 1
              ? `Sorry, there are only ${event.rsvpLimit - currentTotal} spot(s) left, but you requested ${guestCount}.`
              : "Sorry, this event has reached its RSVP limit.",
          values: raw,
        });
      }
    }

    // Check capacity for questions with quantity limits FIRST
    // This prevents issues where a required question is full
    for (const question of event.questions) {
      if (responses[question.id] && question.quantity) {
        const responseCount = question.responses.length;
        if (responseCount >= question.quantity) {
          return fail(400, {
            success: false,
            message: `Sorry, "${question.label}" is full (all ${question.quantity} slots taken).`,
            values: raw,
          });
        }
      }
    }

    // Enforce per-guest Spotify song limits
    for (const question of event.questions) {
      if (question.type !== "spotify_playlist" || !question.songsPerUser) {
        continue;
      }

      const tracks = parseSpotifySelection(responses[question.id]);
      if (tracks.length > question.songsPerUser) {
        return fail(400, {
          success: false,
          message: `You can add at most ${question.songsPerUser} song${
            question.songsPerUser === 1 ? "" : "s"
          } for "${question.label}".`,
          values: raw,
        });
      }
    }

    // Check if all required questions are answered
    // But only for questions that aren't full
    const requiredQuestions = event.questions.filter((q) => q.required);
    const missingRequired = requiredQuestions.filter((q) => {
      // If question has a quantity limit and is full, don't require it
      if (q.quantity && q.responses.length >= q.quantity) {
        return false;
      }
      // Otherwise, check if it's answered
      return !responses[q.id] || responses[q.id].trim() === "";
    });

    if (missingRequired.length > 0) {
      return fail(400, {
        success: false,
        message: "Please answer all required questions.",
        values: raw,
      });
    }

    const pinHash = hashPin(pin);

    // Check for duplicate PIN
    const existingRsvp = await prisma.rsvp.findFirst({
      where: { eventId: event.id, pinHash },
    });

    if (existingRsvp) {
      return fail(400, {
        success: false,
        message:
          "That PIN is already in use for this event. Please choose a different one.",
        values: raw,
      });
    }

    // Create RSVP and responses
    const rsvp = await prisma.rsvp.create({
      data: {
        name,
        email: email ?? null,
        status,
        guestCount,
        pinHash,
        eventId: event.id,
        responses: {
          create: Object.entries(responses)
            .filter(([_, answer]) => answer && answer.trim() !== "")
            .map(([questionId, answer]) => ({
              questionId,
              value: answer,
            })),
        },
      },
      select: { id: true },
    });

    // Fetch updated data to return
    const updatedEvent = await prisma.event.findUnique({
      where: { id: event.id },
      select: {
        questions: {
          select: {
            id: true,
            responses: {
              select: {
                id: true,
              },
            },
          },
        },
        rsvps: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            name: true,
            status: true,
            guestCount: true,
            createdAt: true,
            responses: {
              select: {
                value: true,
                question: { select: { id: true, label: true, type: true } },
              },
            },
          },
        },
      },
    });

    const updatedRsvps = updatedEvent?.rsvps ?? [];
    const updatedRsvpCount = updatedRsvps.length;
    const updatedTotalGuests = updatedRsvps.reduce(
      (sum, r) => sum + r.guestCount,
      0
    );

    await syncSpotifyPlaylists(event.id).catch((error) => {
      console.error("Spotify sync failed after RSVP create", error);
    });

    return {
      success: true,
      rsvpId: rsvp.id,
      rsvpCount: updatedRsvpCount,
      totalGuests: updatedTotalGuests,
      questionResponseCounts: Object.fromEntries(
        (updatedEvent?.questions ?? []).map((q) => [q.id, q.responses.length])
      ),
      rsvps: updatedRsvps.map((r) => ({
        id: r.id,
        name: r.name,
        email: null, // Never expose emails in action response
        status: r.status,
        guestCount: r.guestCount,
        createdAt: r.createdAt,
        responses: r.responses.map((resp) => ({
          questionId: resp.question.id,
          questionLabel: resp.question.label,
          questionType: resp.question.type,
          answer: resp.value,
        })),
      })),
    };
  },

  lookupRsvp: async ({ request, params }) => {
    const formData = await request.formData();
    const rsvpId = formData.get("rsvpId") as string;
    const pin = formData.get("pin") as string;

    if (!rsvpId || !pin) {
      return fail(400, {
        success: false,
        message: "Please provide your RSVP ID and PIN.",
        type: "lookupRsvp",
      });
    }

    const rsvp = await prisma.rsvp.findFirst({
      where: {
        id: rsvpId,
        event: { publicCode: params.code },
      },
      select: {
        id: true,
        name: true,
        email: true,
        status: true,
        guestCount: true,
        pinHash: true,
        responses: {
          select: {
            questionId: true,
            value: true,
            question: { select: { label: true } },
          },
        },
      },
    });

    if (!rsvp || !verifyPin(pin, rsvp.pinHash)) {
      return fail(403, {
        success: false,
        message: "Invalid RSVP ID or PIN.",
        type: "lookupRsvp",
      });
    }

    return {
      success: true,
      type: "lookupRsvp",
      rsvp: {
        id: rsvp.id,
        name: rsvp.name,
        email: rsvp.email,
        status: rsvp.status,
        guestCount: rsvp.guestCount,
        responses: Object.fromEntries(
          rsvp.responses.map((r) => [r.questionId, r.value])
        ),
      },
    };
  },

  updateRsvp: async ({ request, params }) => {
    const event = await prisma.event.findUnique({
      where: { publicCode: params.code },
      select: {
        id: true,
        questions: {
          select: {
            id: true,
            label: true,
            required: true,
            type: true,
            quantity: true,
            songsPerUser: true,
            spotifyPlaylistId: true,
            responses: {
              select: {
                id: true,
              },
            },
          },
        },
      },
    });

    if (!event) {
      throw error(404, "Event not found");
    }

    const formData = await request.formData();
    const rsvpId = formData.get("rsvpId") as string;
    const pin = formData.get("pin") as string;
    const name = formData.get("name") as string;
    const email = formData.get("email") as string;
    const status = (formData.get("status") as string) || "attending";
    const rawGuestCount = formData.get("guestCount") as string;
    const guestCount = Math.min(
      20,
      Math.max(1, Number.parseInt(rawGuestCount, 10) || 1)
    );

    // Parse responses from form data
    const responses: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (key.startsWith("response_")) {
        const questionId = key.replace("response_", "");
        responses[questionId] = value as string;
      }
    }

    if (!rsvpId || !pin) {
      return fail(400, {
        success: false,
        message: "Missing RSVP ID or PIN.",
        type: "updateRsvp",
      });
    }

    const rsvp = await prisma.rsvp.findFirst({
      where: {
        id: rsvpId,
        eventId: event.id,
      },
      select: {
        id: true,
        pinHash: true,
        responses: { select: { id: true, questionId: true } },
      },
    });

    if (!rsvp || !verifyPin(pin, rsvp.pinHash)) {
      return fail(403, {
        success: false,
        message: "Invalid RSVP ID or PIN.",
        type: "updateRsvp",
      });
    }

    // Check capacity for questions with quantity limits FIRST
    for (const question of event.questions) {
      if (responses[question.id] && question.quantity) {
        const currentResponse = rsvp.responses.find(
          (r) => r.questionId === question.id
        );
        // If they weren't signed up before, check capacity
        if (!currentResponse) {
          const responseCount = question.responses.length;
          if (responseCount >= question.quantity) {
            return fail(400, {
              success: false,
              message: `Sorry, "${question.label}" is full (all ${question.quantity} slots taken).`,
              type: "updateRsvp",
            });
          }
        }
      }
    }

    // Enforce per-guest Spotify song limits
    for (const question of event.questions) {
      if (question.type !== "spotify_playlist" || !question.songsPerUser) {
        continue;
      }

      const tracks = parseSpotifySelection(responses[question.id]);
      if (tracks.length > question.songsPerUser) {
        return fail(400, {
          success: false,
          message: `You can add at most ${question.songsPerUser} song${
            question.songsPerUser === 1 ? "" : "s"
          } for "${question.label}".`,
          type: "updateRsvp",
        });
      }
    }

    // Check required questions
    // But only for attending/maybe status and questions that aren't full
    if (status === "attending" || status === "maybe") {
      const requiredQuestions = event.questions.filter((q) => q.required);
      const missingRequired = requiredQuestions.filter((q) => {
        // If question has a quantity limit and is full, don't require it
        if (q.quantity && q.responses.length >= q.quantity) {
          return false;
        }
        // Otherwise, check if it's answered
        return !responses[q.id] || responses[q.id].trim() === "";
      });

      if (missingRequired.length > 0) {
        return fail(400, {
          success: false,
          message: "Please answer all required questions.",
          type: "updateRsvp",
        });
      }
    }

    // Update the RSVP
    await prisma.rsvp.update({
      where: { id: rsvp.id },
      data: {
        name: name || undefined,
        email: email || null,
        status,
        guestCount,
        responses: {
          deleteMany: {},
          create: Object.entries(responses)
            .filter(([_, value]) => value && value.trim() !== "")
            .map(([questionId, value]) => ({
              questionId,
              value,
            })),
        },
      },
    });

    // Fetch updated data to return
    const updatedEvent = await prisma.event.findUnique({
      where: { id: event.id },
      select: {
        questions: {
          select: {
            id: true,
            responses: {
              select: {
                id: true,
              },
            },
          },
        },
        rsvps: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            name: true,
            status: true,
            guestCount: true,
            createdAt: true,
            responses: {
              select: {
                value: true,
                question: { select: { id: true, label: true, type: true } },
              },
            },
          },
        },
      },
    });

    const updatedRsvpsForUpdate = updatedEvent?.rsvps ?? [];
    const updatedTotalGuestsForUpdate = updatedRsvpsForUpdate.reduce(
      (sum, r) => sum + r.guestCount,
      0
    );

    await syncSpotifyPlaylists(event.id).catch((error) => {
      console.error("Spotify sync failed after RSVP update", error);
    });

    return {
      success: true,
      type: "updateRsvp",
      message: "Your RSVP has been updated!",
      totalGuests: updatedTotalGuestsForUpdate,
      questionResponseCounts: Object.fromEntries(
        (updatedEvent?.questions ?? []).map((q) => [q.id, q.responses.length])
      ),
      rsvps: updatedRsvpsForUpdate.map((r) => ({
        id: r.id,
        name: r.name,
        email: null,
        status: r.status,
        guestCount: r.guestCount,
        createdAt: r.createdAt,
        responses: r.responses.map((resp) => ({
          questionId: resp.question.id,
          questionLabel: resp.question.label,
          questionType: resp.question.type,
          answer: resp.value,
        })),
      })),
    };
  },

  cancelRsvp: async ({ request, params }) => {
    const formData = await request.formData();
    const rsvpId = formData.get("rsvpId") as string;
    const pin = formData.get("pin") as string;

    if (!rsvpId || !pin) {
      return fail(400, {
        success: false,
        message: "Missing RSVP ID or PIN.",
        type: "cancelRsvp",
      });
    }

    const rsvp = await prisma.rsvp.findFirst({
      where: {
        id: rsvpId,
        event: { publicCode: params.code },
      },
      select: {
        id: true,
        pinHash: true,
        eventId: true,
      },
    });

    if (!rsvp || !verifyPin(pin, rsvp.pinHash)) {
      return fail(403, {
        success: false,
        message: "Invalid RSVP ID or PIN.",
        type: "cancelRsvp",
      });
    }

    await prisma.rsvp.delete({
      where: { id: rsvp.id },
    });

    await syncSpotifyPlaylists(rsvp.eventId).catch((error) => {
      console.error("Spotify sync failed after RSVP cancellation", error);
    });

    // Fetch updated data to return
    const updatedEvent = await prisma.event.findUnique({
      where: { id: rsvp.eventId },
      select: {
        questions: {
          select: {
            id: true,
            responses: {
              select: {
                id: true,
              },
            },
          },
        },
        rsvps: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            name: true,
            status: true,
            guestCount: true,
            createdAt: true,
            responses: {
              select: {
                value: true,
                question: { select: { id: true, label: true, type: true } },
              },
            },
          },
        },
      },
    });

    const cancelledRsvps = updatedEvent?.rsvps ?? [];
    const cancelledRsvpCount = cancelledRsvps.length;
    const cancelledTotalGuests = cancelledRsvps.reduce(
      (sum, r) => sum + r.guestCount,
      0
    );

    return {
      success: true,
      type: "cancelRsvp",
      message: "Your RSVP has been cancelled.",
      rsvpCount: cancelledRsvpCount,
      totalGuests: cancelledTotalGuests,
      questionResponseCounts: Object.fromEntries(
        (updatedEvent?.questions ?? []).map((q) => [q.id, q.responses.length])
      ),
      rsvps: cancelledRsvps.map((r) => ({
        id: r.id,
        name: r.name,
        email: null,
        status: r.status,
        guestCount: r.guestCount,
        createdAt: r.createdAt,
        responses: r.responses.map((resp) => ({
          questionId: resp.question.id,
          questionLabel: resp.question.label,
          questionType: resp.question.type,
          answer: resp.value,
        })),
      })),
    };
  },
};
