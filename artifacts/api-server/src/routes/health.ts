import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { isMongoDBConnected } from "../lib/mongodb";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const isHealthy = isMongoDBConnected();
  const data = HealthCheckResponse.parse({
    status: isHealthy ? "ok" : "error",
  });
  res.status(isHealthy ? 200 : 503).json(data);
});

export default router;
