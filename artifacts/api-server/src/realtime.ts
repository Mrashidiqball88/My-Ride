import type { Server as HttpServer } from "node:http";
import { ObjectId } from "mongodb";
import { Server } from "socket.io";
import { z } from "zod";
import { verifyAuthToken } from "./middleware/auth";
import { getMongoDB } from "./lib/mongodb";
import { logger } from "./lib/logger";
import {
  getRidesCollection,
  toPublicRide,
  type RideDocument,
  type RideStatus,
} from "./models/ride";

const locationSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});

const rideIdSchema = z.object({
  rideId: z.string().min(1),
});

const locationUpdateSchema = rideIdSchema.extend(locationSchema.shape);
const statusUpdateSchema = rideIdSchema.extend({
  status: z.enum(["arrived", "in-progress", "completed"]),
});

type Ack = (response: {
  ok: boolean;
  message?: string;
  ride?: ReturnType<typeof toPublicRide>;
}) => void;

type SocketData = {
  userId: string;
};

let io: Server | undefined;

const userRoom = (userId: string) => `user:${userId}`;
const rideRoom = (rideId: string) => `ride:${rideId}`;

function getHandshakeToken(socket: {
  handshake: {
    auth: Record<string, unknown>;
    headers: Record<string, string | string[] | undefined>;
  };
}): string | undefined {
  const authToken = socket.handshake.auth["token"];
  if (typeof authToken === "string" && authToken.length > 0) {
    return authToken.startsWith("Bearer ")
      ? authToken.slice("Bearer ".length)
      : authToken;
  }

  const authorization = socket.handshake.headers.authorization;
  if (typeof authorization !== "string") {
    return undefined;
  }

  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : authorization;
}

function rejectAck(ack: Ack | undefined, message: string): void {
  ack?.({ ok: false, message });
}

function emitToRideParticipants(
  ride: RideDocument,
  event: string,
  payload: unknown,
): void {
  if (!io) {
    return;
  }

  const participantRooms = [
    rideRoom(ride._id.toHexString()),
    userRoom(ride.passengerId),
    ride.driverId ? userRoom(ride.driverId) : undefined,
  ].filter((room): room is string => Boolean(room));

  io.to(participantRooms).emit(event, payload);
}

export function emitRideStatus(ride: RideDocument): void {
  emitToRideParticipants(ride, "ride:status", {
    rideId: ride._id.toHexString(),
    status: ride.status,
    passengerId: ride.passengerId,
    driverId: ride.driverId,
    ride: toPublicRide(ride),
  });
}

export function initializeRealtime(httpServer: HttpServer): Server {
  io = new Server< never, never, never, SocketData>(httpServer, {
    path: "/api/socket.io",
    cors: {
      origin: true,
      credentials: true,
    },
  });

  io.use((socket, next) => {
    const token = getHandshakeToken(socket);
    const userId = token ? verifyAuthToken(token) : undefined;

    if (!userId) {
      next(new Error("Authentication required."));
      return;
    }

    socket.data.userId = userId;
    next();
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId;
    socket.join(userRoom(userId));
    socket.emit("realtime:ready", { userId });

    socket.on("ride:join", async (rawPayload: unknown, ack?: Ack) => {
      try {
        const payload = rideIdSchema.parse(rawPayload);
        if (!ObjectId.isValid(payload.rideId)) {
          rejectAck(ack, "Invalid ride ID.");
          return;
        }

        const rides = await getRidesCollection(getMongoDB());
        const ride = await rides.findOne({ _id: new ObjectId(payload.rideId) });

        if (
          !ride ||
          (ride.passengerId !== userId && ride.driverId !== userId)
        ) {
          rejectAck(ack, "Ride not found or access denied.");
          return;
        }

        await socket.join(rideRoom(payload.rideId));
        ack?.({ ok: true, ride: toPublicRide(ride) });
      } catch (error) {
        logger.warn({ err: error, event: "ride:join" }, "Socket event rejected");
        rejectAck(ack, "Invalid ride join request.");
      }
    });

    socket.on(
      "driver:location:update",
      async (rawPayload: unknown, ack?: Ack) => {
        try {
          const payload = locationUpdateSchema.parse(rawPayload);
          if (!ObjectId.isValid(payload.rideId)) {
            rejectAck(ack, "Invalid ride ID.");
            return;
          }

          const rides = await getRidesCollection(getMongoDB());
          const locationUpdatedAt = new Date();
          const ride = await rides.findOneAndUpdate(
            {
              _id: new ObjectId(payload.rideId),
              driverId: userId,
              status: { $in: ["accepted", "arrived", "in-progress"] },
            },
            {
              $set: {
                driverLocation: {
                  latitude: payload.latitude,
                  longitude: payload.longitude,
                },
                locationUpdatedAt,
              },
            },
            { returnDocument: "after" },
          );

          if (!ride) {
            rejectAck(ack, "Ride not found or location updates are not allowed.");
            return;
          }

          await socket.join(rideRoom(payload.rideId));
          emitToRideParticipants(ride, "ride:location", {
            rideId: payload.rideId,
            driverId: userId,
            location: ride.driverLocation,
            updatedAt: locationUpdatedAt,
          });
          ack?.({ ok: true, ride: toPublicRide(ride) });
        } catch (error) {
          logger.warn(
            { err: error, event: "driver:location:update" },
            "Socket event rejected",
          );
          rejectAck(ack, "Invalid driver location update.");
        }
      },
    );

    socket.on(
      "ride:status:update",
      async (rawPayload: unknown, ack?: Ack) => {
        try {
          const payload = statusUpdateSchema.parse(rawPayload);
          if (!ObjectId.isValid(payload.rideId)) {
            rejectAck(ack, "Invalid ride ID.");
            return;
          }

          const rideId = new ObjectId(payload.rideId);
          const rides = await getRidesCollection(getMongoDB());
          const currentRide = await rides.findOne({ _id: rideId });

          if (!currentRide || currentRide.driverId !== userId) {
            rejectAck(ack, "Ride not found or access denied.");
            return;
          }

          const allowedNextStatuses: Record<RideStatus, RideStatus[]> = {
            requested: [],
            accepted: ["arrived"],
            arrived: ["in-progress"],
            "in-progress": ["completed"],
            completed: [],
          };

          if (!allowedNextStatuses[currentRide.status].includes(payload.status)) {
            rejectAck(ack, "Invalid ride status transition.");
            return;
          }

          const ride = await rides.findOneAndUpdate(
            {
              _id: rideId,
              driverId: userId,
              status: currentRide.status,
            },
            { $set: { status: payload.status } },
            { returnDocument: "after" },
          );

          if (!ride) {
            rejectAck(ack, "Ride status changed before this update completed.");
            return;
          }

          await socket.join(rideRoom(payload.rideId));
          emitRideStatus(ride);
          ack?.({ ok: true, ride: toPublicRide(ride) });
        } catch (error) {
          logger.warn(
            { err: error, event: "ride:status:update" },
            "Socket event rejected",
          );
          rejectAck(ack, "Invalid ride status update.");
        }
      },
    );

    socket.on("disconnect", (reason) => {
      logger.info({ userId, reason }, "Realtime client disconnected");
    });
  });

  return io;
}