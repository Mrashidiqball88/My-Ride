import { MongoClient, type Db } from "mongodb";
import { logger } from "./logger";

const mongoUri = process.env["MONGO_URI"];

if (!mongoUri) {
  throw new Error(
    "MONGO_URI environment variable is required but was not provided.",
  );
}

function normalizeMongoUri(uri: string): string {
  const schemeEnd = uri.indexOf("://");
  if (schemeEnd === -1) {
    return uri;
  }

  const authorityStart = schemeEnd + 3;
  const userInfoSeparator = uri.lastIndexOf("@");

  if (userInfoSeparator < authorityStart) {
    return uri;
  }

  const userInfo = uri.slice(authorityStart, userInfoSeparator);
  const passwordSeparator = userInfo.indexOf(":");

  if (passwordSeparator === -1) {
    return uri;
  }

  const username = userInfo.slice(0, passwordSeparator);
  const password = userInfo.slice(passwordSeparator + 1);

  const normalizeCredential = (credential: string): string =>
    credential.replace(/%[0-9a-f]{2}|./giu, (character) =>
      character.startsWith("%")
        ? character.toUpperCase()
        : encodeURIComponent(character),
    );

  const normalizedUserInfo = `${normalizeCredential(username)}:${normalizeCredential(password)}`;
  return `${uri.slice(0, authorityStart)}${normalizedUserInfo}${uri.slice(userInfoSeparator)}`;
}

export const mongoClient = new MongoClient(normalizeMongoUri(mongoUri), {
  serverSelectionTimeoutMS: 5_000,
});

let database: Db | undefined;

export async function connectToMongoDB(): Promise<Db> {
  if (database) {
    return database;
  }

  await mongoClient.connect();
  database = mongoClient.db();
  logger.info("Connected to MongoDB");
  return database;
}

export function getMongoDB(): Db {
  if (!database) {
    throw new Error("MongoDB is not connected.");
  }

  return database;
}

export function isMongoDBConnected(): boolean {
  return database !== undefined;
}

export async function closeMongoDB(): Promise<void> {
  if (!database) {
    return;
  }

  await mongoClient.close();
  database = undefined;
  logger.info("Disconnected from MongoDB");
}