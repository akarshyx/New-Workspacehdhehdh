import { Router, type IRouter } from "express";
import collectiblesRouter from "./collectibles";
import healthRouter from "./health";
import telegramAuthRouter from "./telegram-auth";

const router: IRouter = Router();

router.use(collectiblesRouter);
router.use(telegramAuthRouter);
router.use(healthRouter);

export default router;
