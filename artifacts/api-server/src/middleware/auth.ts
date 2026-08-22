import type { NextFunction, Request, Response } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";

const jwtSecret =
  process.env["JWT_SECRET"] ??
  (() => {
    throw new Error(
      "JWT_SECRET environment variable is required but was not provided.",
    );
  })();

declare global {
  namespace Express {
    interface Request {
      authUserId?: string;
    }
  }
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authorization = req.header("authorization");
  const [scheme, token] = authorization?.split(" ") ?? [];

  if (scheme?.toLowerCase() !== "bearer" || !token) {
    res.status(401).json({ message: "Authentication required." });
    return;
  }

  try {
    const userId = verifyAuthToken(token);

    if (!userId) {
      res.status(401).json({ message: "Invalid authentication token." });
      return;
    }

    req.authUserId = userId;
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired authentication token." });
  }
}

export function verifyAuthToken(token: string): string | undefined {
  try {
    const payload = jwt.verify(token, jwtSecret);
    return typeof payload === "string"
      ? undefined
      : (payload as JwtPayload).sub;
  } catch {
    return undefined;
  }
}

export function createAuthToken(userId: string): string {
  return jwt.sign({ sub: userId }, jwtSecret, { expiresIn: "7d" });
}