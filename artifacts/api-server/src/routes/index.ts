import { Router, type IRouter } from "express";
import healthRouter from "./health";
import mirrorRouter from "./mirror";

const router: IRouter = Router();

router.use(healthRouter);
router.use(mirrorRouter);

export default router;
