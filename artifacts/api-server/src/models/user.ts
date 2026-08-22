import { ObjectId, type Collection, type Db } from "mongodb";

export interface UserDocument {
  _id: ObjectId;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

export interface PublicUser {
  id: string;
  email: string;
  createdAt: Date;
}

let usersCollection: Collection<UserDocument> | undefined;

export async function getUsersCollection(db: Db): Promise<Collection<UserDocument>> {
  if (!usersCollection) {
    usersCollection = db.collection<UserDocument>("users");
    await usersCollection.createIndex({ email: 1 }, { unique: true });
  }

  return usersCollection;
}

export function toPublicUser(user: UserDocument): PublicUser {
  return {
    id: user._id.toHexString(),
    email: user.email,
    createdAt: user.createdAt,
  };
}