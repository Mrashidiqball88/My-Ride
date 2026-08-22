import { Router, type IRouter } from "express";
import { ObjectId } from "mongodb";
import bcrypt from "bcrypt";
import {
  GetCurrentUserResponse,
  LogInBody,
  LogInResponse,
  SignUpBody,
  SignUpResponse,
} from "@workspace/api-zod";
import { requireAuth, createAuthToken } from "../middleware/auth";
import { getMongoDB } from "../lib/mongodb";
import {
  getUsersCollection,
  toPublicUser,
  type UserDocument,
} from "../models/user";

const router: IRouter = Router();
const passwordSaltRounds = 12;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validationMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid request body.";
}

function normalizeEmailForLookup(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Email must be a string.");
  }
  const email = value.trim().toLowerCase();
  if (!emailPattern.test(email)) {
    throw new Error("A valid email address is required.");
  }
  return email;
}

function userEmailFilter(email: string) {
  // `$eq` receives a validated scalar only. Keeping the query construction
  // isolated prevents a request object from ever becoming a MongoDB operator.
  return { email: { $eq: email } };
}

router.post("/auth/signup", async (req, res) => {
  let credentials;
  try {
    credentials = SignUpBody.parse(req.body);
  } catch (error) {
    res.status(400).json({ message: validationMessage(error) });
    return;
  }

  const users = await getUsersCollection(getMongoDB());
  const email = normalizeEmailForLookup(credentials.email);
  const existingUser = await users.findOne(userEmailFilter(email));

  if (existingUser) {
    res.status(409).json({ message: "An account with this email already exists." });
    return;
  }

  const user: UserDocument = {
    _id: new ObjectId(),
    email,
    passwordHash: await bcrypt.hash(credentials.password, passwordSaltRounds),
    createdAt: new Date(),
  };

  try {
    await users.insertOne(user);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 11000
    ) {
      res.status(409).json({ message: "An account with this email already exists." });
      return;
    }
    throw error;
  }

  const response = SignUpResponse.parse({
    token: createAuthToken(user._id.toHexString()),
    user: toPublicUser(user),
  });
  res.status(201).json(response);
});

router.post("/auth/login", async (req, res) => {
  let credentials;
  try {
    credentials = LogInBody.parse(req.body);
  } catch (error) {
    res.status(400).json({ message: validationMessage(error) });
    return;
  }

  const users = await getUsersCollection(getMongoDB());
  const email = normalizeEmailForLookup(credentials.email);
  const user = await users.findOne(userEmailFilter(email));

  if (!user || !(await bcrypt.compare(credentials.password, user.passwordHash))) {
    res.status(401).json({ message: "Invalid email or password." });
    return;
  }

  const response = LogInResponse.parse({
    token: createAuthToken(user._id.toHexString()),
    user: toPublicUser(user),
  });
  res.json(response);
});

router.get("/auth/me", requireAuth, async (req, res) => {
  const userId = req.authUserId;

  if (!userId || !ObjectId.isValid(userId)) {
    res.status(401).json({ message: "Invalid authentication token." });
    return;
  }

  const users = await getUsersCollection(getMongoDB());
  const user = await users.findOne({ _id: new ObjectId(userId) });

  if (!user) {
    res.status(401).json({ message: "User account no longer exists." });
    return;
  }

  const response = GetCurrentUserResponse.parse({ user: toPublicUser(user) });
  res.json(response);
});

export default router;