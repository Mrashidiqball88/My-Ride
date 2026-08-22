import { Router, type IRouter } from "express";
import authRouter from "./auth";
import healthRouter from "./health";
import ridesRouter from "./rides";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(ridesRouter);

export default router;
