import { Router, type IRouter } from "express";
import collectiblesRouter from "./collectibles";
import healthRouter from "./health";

const router: IRouter = Router();

router.use(collectiblesRouter);
router.use(healthRouter);

export default router;
