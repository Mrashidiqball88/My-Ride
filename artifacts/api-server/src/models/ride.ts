import { ObjectId, type Collection, type Db } from "mongodb";

export type RideStatus =
  | "requested"
  | "accepted"
  | "arrived"
  | "in-progress"
  | "completed";

export interface Location {
  latitude: number;
  longitude: number;
}

export interface RideDocument {
  _id: ObjectId;
  pickupLocation: Location;
  dropoffLocation: Location;
  fare: number;
  status: RideStatus;
  passengerId: string;
  driverId: string | null;
  driverLocation: Location | null;
  locationUpdatedAt: Date | null;
  createdAt: Date;
  acceptedAt: Date | null;
}

export interface PublicRide {
  id: string;
  pickupLocation: Location;
  dropoffLocation: Location;
  fare: number;
  status: RideStatus;
  passengerId: string;
  driverId: string | null;
  driverLocation: Location | null;
  locationUpdatedAt: Date | null;
  createdAt: Date;
  acceptedAt: Date | null;
}

let ridesCollection: Collection<RideDocument> | undefined;

export async function getRidesCollection(
  db: Db,
): Promise<Collection<RideDocument>> {
  if (!ridesCollection) {
    ridesCollection = db.collection<RideDocument>("rides");
    await ridesCollection.createIndex({ status: 1, createdAt: 1 });
    await ridesCollection.createIndex({ passengerId: 1, createdAt: -1 });
    await ridesCollection.createIndex({ driverId: 1, createdAt: -1 });
  }

  return ridesCollection;
}

export function toPublicRide(ride: RideDocument): PublicRide {
  return {
    id: ride._id.toHexString(),
    pickupLocation: ride.pickupLocation,
    dropoffLocation: ride.dropoffLocation,
    fare: ride.fare,
    status: ride.status,
    passengerId: ride.passengerId,
    driverId: ride.driverId,
    driverLocation: ride.driverLocation ?? null,
    locationUpdatedAt: ride.locationUpdatedAt ?? null,
    createdAt: ride.createdAt,
    acceptedAt: ride.acceptedAt,
  };
}