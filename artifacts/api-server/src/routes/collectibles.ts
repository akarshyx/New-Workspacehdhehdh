import { Router, type IRouter } from "express";
import {
  GetBotStatusResponse,
  GetDashboardResponse,
  ListCollectiblesResponse,
  ListPurchasesResponse,
  ListOwnedCollectiblesResponse,
  ListPrepaidUpgradeGiftsResponse,
  SendBotGiftBody,
  SendBotGiftResponse,
  GiftPremiumSubscriptionBody,
  GiftPremiumSubscriptionResponse,
} from "@workspace/api-zod";

type Purchase = {
  id: string;
  collectibleId: string;
  collectibleName: string;
  priceStars: number;
  transferFeeStars: number;
  totalCostStars: number;
  recipientChatId: string;
  status: "queued" | "sent" | "failed" | "manual_review";
  createdAt: string | Date;
  message: string;
};

const purchases: Purchase[] = [];

async function telegramRequest<T>(
  method: string,
  body?: Record<string, string | number | boolean>,
): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("Telegram bot token is not configured");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const payload = (await response.json()) as {
    ok: boolean;
    result?: T;
    description?: string;
  };

  if (!response.ok || !payload.ok || payload.result === undefined) {
    throw new Error(payload.description ?? `Telegram request failed (${response.status})`);
  }

  return payload.result;
}

type TelegramGift = {
  id: string;
  star_count: number;
  upgrade_star_count?: number;
  is_premium?: boolean;
  remaining_count?: number;
  personal_remaining_count?: number;
};

async function getAvailableGifts() {
  return telegramRequest<{ gifts: TelegramGift[] }>("getAvailableGifts");
}

async function getBotStatus() {
  try {
    const bot = await telegramRequest<{ first_name: string; username?: string }>("getMe");
    const balance = await telegramRequest<{ amount: number }>("getMyStarBalance");
    return GetBotStatusResponse.parse({
      connected: true,
      botName: bot.first_name,
      username: bot.username ?? "Telegram bot",
      starBalance: balance.amount,
      balanceVerified: true,
      recipientConfigured: false,
      collectibleGiftsOnly: true,
      transactionExecutable: false,
      executionBlockReason:
        "This app has no owner-only purchase flow enabled, so Stars cannot be spent from this screen.",
      message: "Live Telegram bot status and Star balance are verified. Purchases remain disabled.",
    });
  } catch (error) {
    return GetBotStatusResponse.parse({
      connected: false,
      botName: "Telegram bot",
      username: "Not connected",
      starBalance: 0,
      balanceVerified: false,
      recipientConfigured: false,
      collectibleGiftsOnly: true,
      transactionExecutable: false,
      executionBlockReason: "Blocked because the Telegram bot connection could not be verified.",
      message:
        error instanceof Error
          ? error.message
          : "Telegram connection could not be verified.",
    });
  }
}

const router: IRouter = Router();

router.get("/collectibles", (_req, res) => {
  // The old project exposed a fabricated collectible catalog here. Keep the
  // route for compatibility, but never invent catalog entries.
  res.json(ListCollectiblesResponse.parse([]));
});

router.get("/bot/status", async (_req, res) => {
  res.json(await getBotStatus());
});

router.get("/owned-collectibles", (_req, res) => {
  res.json(
    ListOwnedCollectiblesResponse.parse({
      items: [],
      supported: false,
      message: "Not supported by current Bot API. Owned collectible inventory and transfers are unavailable in read-only mode.",
    }),
  );
});

router.get("/bot/prepaid-upgrade-gifts", async (_req, res) => {
  try {
    const available = await getAvailableGifts();
    const balance = await telegramRequest<{ amount: number }>("getMyStarBalance");
    const gifts = available.gifts
      .filter((gift) => typeof gift.upgrade_star_count === "number" && gift.upgrade_star_count > 0)
      .slice(0, 7)
      .map((gift) => {
        const upgradeFeeStars = typeof gift.upgrade_star_count === "number"
          ? gift.upgrade_star_count
          : null;
        const totalStars = gift.star_count + (upgradeFeeStars ?? 0);
        return {
          id: gift.id,
          giftPriceStars: gift.star_count,
          upgradeFeeStars,
          totalStars,
          affordable: totalStars <= balance.amount,
          payForUpgrade: false,
          isPremiumOnly: gift.is_premium ?? false,
          remainingCount: gift.remaining_count ?? null,
          personalRemainingCount: gift.personal_remaining_count ?? null,
        };
      })

    res.json(
      ListPrepaidUpgradeGiftsResponse.parse({
        supported: true,
        recipientUserId: "8598790977",
        botBalanceStars: balance.amount,
        gifts,
        message: gifts.length
          ? "Eligible Unique / Collectible Gift candidates returned by Telegram. No Stars were spent; approval is required before each individual purchase and upgrade."
          : "No currently available gift supports the requested collectible-upgrade flow through the Bot API.",
      }),
    );
  } catch (error) {
    res.json(
      ListPrepaidUpgradeGiftsResponse.parse({
        supported: false,
        recipientUserId: "8598790977",
        botBalanceStars: 0,
        gifts: [],
        message:
          error instanceof Error
            ? `Not supported by current Bot API: ${error.message}`
            : "Not supported by current Bot API.",
      }),
    );
  }
});

router.post("/bot/gifts/send", async (req, res) => {
  const input = SendBotGiftBody.parse(req.body);
  if (!input.confirmed) {
    res.status(400).json({ error: "Explicit confirmation is required before sending a gift." });
    return;
  }
  if (!input.payForUpgrade) {
    res.status(400).json({ error: "Only a confirmed gift upgrade flow is allowed; ordinary gifts cannot be sent here." });
    return;
  }

  try {
    const available = await getAvailableGifts();
    const gift = available.gifts.find((candidate) => candidate.id === input.giftId);
    if (!gift) {
      res.status(400).json({ error: "Telegram no longer lists this gift as available." });
      return;
    }

    const upgradeFeeStars = typeof gift.upgrade_star_count === "number"
      ? gift.upgrade_star_count
      : null;
    if (upgradeFeeStars === null) {
      res.status(400).json({ error: "Telegram does not expose an upgrade price for this gift." });
      return;
    }

    await telegramRequest<boolean>("sendGift", {
      user_id: 8598790977,
      gift_id: gift.id,
      ...(input.payForUpgrade ? { pay_for_upgrade: true } : {}),
    });

    res.json(
      SendBotGiftResponse.parse({
        success: true,
        giftId: gift.id,
        recipientUserId: "8598790977",
        giftPriceStars: gift.star_count,
        upgradeFeeStars: input.payForUpgrade ? upgradeFeeStars : null,
        totalStars: gift.star_count + (input.payForUpgrade ? upgradeFeeStars ?? 0 : 0),
        message: "Telegram confirmed the gift send.",
      }),
    );
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : "Telegram could not confirm the gift send.",
    });
  }
});

router.post("/bot/premium/gift", async (req, res) => {
  const input = GiftPremiumSubscriptionBody.parse(req.body);
  if (!input.confirmed) {
    res.status(400).json({ error: "Explicit confirmation is required before gifting Premium." });
    return;
  }

  try {
    await telegramRequest<boolean>("giftPremiumSubscription", {
      user_id: 8598790977,
      month_count: 3,
      star_count: 1000,
    });

    res.json(
      GiftPremiumSubscriptionResponse.parse({
        success: true,
        recipientUserId: "8598790977",
        monthCount: 3,
        starCount: 1000,
        message: "Telegram confirmed the three-month Premium gift.",
      }),
    );
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : "Telegram could not confirm the Premium gift.",
    });
  }
});

router.get("/purchases", (_req, res) => {
  res.json(ListPurchasesResponse.parse(purchases.slice(0, 12)));
});

router.get("/dashboard", async (_req, res) => {
  const bot = await getBotStatus();
  const totalSpent = purchases.reduce((sum, purchase) => sum + purchase.totalCostStars, 0);
  const deliveredCount = purchases.filter((purchase) => purchase.status === "sent").length;
  const queuedCount = purchases.filter(
    (purchase) => purchase.status === "queued" || purchase.status === "manual_review",
  ).length;

  res.json(
    GetDashboardResponse.parse({
      starBalance: bot.starBalance,
      totalSpent,
      deliveredCount,
      queuedCount,
      bot,
      recentPurchases: purchases.slice(0, 5),
    }),
  );
});

export default router;