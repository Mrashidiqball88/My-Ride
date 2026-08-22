import { Router, type IRouter } from "express";
import { ObjectId } from "mongodb";
import {
  AcceptRideParams,
  AcceptRideResponse,
  CreateRideBody,
  CreateRideResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middleware/auth";
import { getMongoDB } from "../lib/mongodb";
import { emitRideStatus } from "../realtime";
import {
  getRidesCollection,
  toPublicRide,
  type RideDocument,
} from "../models/ride";

const router: IRouter = Router();

function validationMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid request.";
}

router.post("/rides", requireAuth, async (req, res) => {
  let rideDetails;
  try {
    rideDetails = CreateRideBody.parse(req.body);
  } catch (error) {
    res.status(400).json({ message: validationMessage(error) });
    return;
  }

  const passengerId = req.authUserId;
  if (!passengerId) {
    res.status(401).json({ message: "Authentication required." });
    return;
  }

  const ride: RideDocument = {
    _id: new ObjectId(),
    pickupLocation: rideDetails.pickupLocation,
    dropoffLocation: rideDetails.dropoffLocation,
    fare: rideDetails.fare,
    status: "requested",
    passengerId,
    driverId: null,
    driverLocation: null,
    locationUpdatedAt: null,
    createdAt: new Date(),
    acceptedAt: null,
  };

  const rides = await getRidesCollection(getMongoDB());
  await rides.insertOne(ride);

  const response = CreateRideResponse.parse({ ride: toPublicRide(ride) });
  emitRideStatus(ride);
  res.status(201).json(response);
});

router.patch("/rides/:rideId/accept", requireAuth, async (req, res) => {
  let rideParams;
  try {
    rideParams = AcceptRideParams.parse(req.params);
  } catch (error) {
    res.status(400).json({ message: validationMessage(error) });
    return;
  }

  const driverId = req.authUserId;
  if (!driverId) {
    res.status(401).json({ message: "Authentication required." });
    return;
  }

  if (!ObjectId.isValid(rideParams.rideId)) {
    res.status(400).json({ message: "Invalid ride ID." });
    return;
  }

  const rideId = new ObjectId(rideParams.rideId);
  const rides = await getRidesCollection(getMongoDB());
  const existingRide = await rides.findOne({ _id: rideId });

  if (!existingRide) {
    res.status(404).json({ message: "Ride request not found." });
    return;
  }

  if (existingRide.status !== "requested") {
    res.status(409).json({ message: "Ride request is no longer available." });
    return;
  }

  if (existingRide.passengerId === driverId) {
    res.status(409).json({ message: "A passenger cannot accept their own ride." });
    return;
  }

  const acceptedAt = new Date();
  const acceptedRide = await rides.findOneAndUpdate(
    {
      _id: rideId,
      status: "requested",
      passengerId: { $ne: driverId },
    },
    {
      $set: {
        status: "accepted",
        driverId,
        acceptedAt,
      },
    },
    { returnDocument: "after" },
  );

  if (!acceptedRide) {
    res.status(409).json({ message: "Ride request is no longer available." });
    return;
  }

  const response = AcceptRideResponse.parse({
    ride: toPublicRide(acceptedRide),
  });
  emitRideStatus(acceptedRide);
  res.json(response);
});

export default router;