import { Router, type IRouter } from "express";
import { TelegramClient } from "telegram";
import { Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { storeTelegramUserSession, loadTelegramUserSession } from "../lib/telegram-user-session";

type PendingAuth = {
  client: TelegramClient;
  phoneNumber: string;
  phoneCodeHash: string;
  createdAt: number;
};

const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;
let pendingAuth: PendingAuth | null = null;

function getApiCredentials() {
  const apiId = Number(process.env.TELEGRAM_USER_API_ID);
  const apiHash = process.env.TELEGRAM_USER_API_HASH?.trim();
  if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) return null;
  return { apiId, apiHash };
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    const message = error.message.replace(/^RPCError:\s*/i, "");
    if (/PHONE_CODE_INVALID|PHONE_CODE_EMPTY/i.test(message)) return "That Telegram code is invalid.";
    if (/PHONE_CODE_EXPIRED/i.test(message)) return "That Telegram code expired. Request a new code.";
    if (/PHONE_NUMBER_INVALID/i.test(message)) return "Telegram rejected that phone number.";
    if (/PHONE_NUMBER_BANNED/i.test(message)) return "Telegram rejected this phone number as banned.";
    if (/FLOOD_WAIT/i.test(message)) return "Telegram asked us to wait before trying again.";
    if (/PASSWORD_HASH_INVALID/i.test(message)) return "That Telegram 2FA password is incorrect.";
    if (/SESSION_PASSWORD_NEEDED/i.test(message)) return "Telegram requires the account 2FA password.";
    return message;
  }
  return "Telegram authorization failed.";
}

function requirePendingAuth() {
  if (!pendingAuth || Date.now() - pendingAuth.createdAt > PENDING_AUTH_TTL_MS) {
    pendingAuth = null;
    throw new Error("The Telegram code request expired. Request a new code.");
  }
  return pendingAuth;
}

async function createClient() {
  const credentials = getApiCredentials();
  if (!credentials) throw new Error("Telegram user API ID and API hash are not configured.");
  const session = await loadTelegramUserSession();
  const client = new TelegramClient(
    new StringSession(session ?? ""),
    credentials.apiId,
    credentials.apiHash,
    { connectionRetries: 3 },
  );
  await client.connect();
  return { client, credentials, hasSession: Boolean(session) };
}

function saveClientSession(client: TelegramClient) {
  return (client.session as StringSession).save();
}

function authorizedResponse(message: string) {
  return {
    configured: true,
    authorized: true,
    pending: false,
    needsPassword: false,
    message,
  };
}

const router: IRouter = Router();

router.get("/telegram/user-auth/status", async (_req, res) => {
  if (!getApiCredentials()) {
    res.json({
      configured: false,
      authorized: false,
      pending: false,
      needsPassword: false,
      message: "Telegram user API credentials are not configured.",
    });
    return;
  }

  try {
    const { client, hasSession } = await createClient();
    const authorized = await client.checkAuthorization();
    await client.disconnect();
    res.json({
      configured: true,
      authorized,
      pending: Boolean(pendingAuth),
      needsPassword: false,
      message: authorized
        ? "Your Telegram account is authorized for discovery."
        : hasSession
          ? "The stored Telegram session is not authorized."
          : "Authorize your Telegram account to enable resale discovery.",
    });
  } catch (error) {
    res.status(502).json({
      configured: true,
      authorized: false,
      pending: Boolean(pendingAuth),
      needsPassword: false,
      message: getErrorMessage(error),
    });
  }
});

router.post("/telegram/user-auth/send-code", async (req, res) => {
  const credentials = getApiCredentials();
  const phoneNumber = typeof req.body?.phoneNumber === "string"
    ? req.body.phoneNumber.trim()
    : "";

  if (!credentials) {
    res.status(503).json({ error: "Telegram user API credentials are not configured." });
    return;
  }
  if (!/^\+?[1-9][0-9\s().-]{5,20}$/.test(phoneNumber)) {
    res.status(400).json({ error: "Enter the Telegram phone number in international format." });
    return;
  }

  try {
    if (pendingAuth) await pendingAuth.client.disconnect();
    const client = new TelegramClient(
      new StringSession(""),
      credentials.apiId,
      credentials.apiHash,
      { connectionRetries: 3 },
    );
    await client.connect();
    const result = await client.sendCode(credentials, phoneNumber);
    pendingAuth = {
      client,
      phoneNumber,
      phoneCodeHash: result.phoneCodeHash,
      createdAt: Date.now(),
    };
    res.json({
      status: "code_sent",
      isCodeViaApp: result.isCodeViaApp,
      message: result.isCodeViaApp
        ? "Telegram sent the login code in the Telegram app."
        : "Telegram sent the login code by SMS.",
    });
  } catch (error) {
    pendingAuth = null;
    res.status(502).json({ error: getErrorMessage(error) });
  }
});

router.post("/telegram/user-auth/verify-code", async (req, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (!code) {
    res.status(400).json({ error: "Enter the Telegram login code." });
    return;
  }

  try {
    const auth = requirePendingAuth();
    const credentials = getApiCredentials();
    if (!credentials) throw new Error("Telegram user API credentials are not configured.");
    await auth.client.invoke(new Api.auth.SignIn({
      phoneNumber: auth.phoneNumber,
      phoneCodeHash: auth.phoneCodeHash,
      phoneCode: code,
    }));
    await storeTelegramUserSession(saveClientSession(auth.client));
    await auth.client.disconnect();
    pendingAuth = null;
    res.json(authorizedResponse("Telegram account authorized and the encrypted discovery session was stored."));
  } catch (error) {
    if (/SESSION_PASSWORD_NEEDED/i.test(error instanceof Error ? error.message : "")) {
      res.json({
        configured: true,
        authorized: false,
        pending: true,
        needsPassword: true,
        message: "Telegram requires your account 2FA password to finish authorization.",
      });
      return;
    }
    res.status(502).json({ error: getErrorMessage(error) });
  }
});

router.post("/telegram/user-auth/verify-password", async (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!password) {
    res.status(400).json({ error: "Enter your Telegram 2FA password." });
    return;
  }

  try {
    const auth = requirePendingAuth();
    const credentials = getApiCredentials();
    if (!credentials) throw new Error("Telegram user API credentials are not configured.");
    await auth.client.signInWithPassword(credentials, {
      password: async () => password,
      onError: async () => false,
    });
    await storeTelegramUserSession(saveClientSession(auth.client));
    await auth.client.disconnect();
    pendingAuth = null;
    res.json(authorizedResponse("Telegram account authorized and the encrypted discovery session was stored."));
  } catch (error) {
    res.status(502).json({ error: getErrorMessage(error) });
  }
});

export default router;