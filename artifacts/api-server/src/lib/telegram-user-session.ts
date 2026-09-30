import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SESSION_FILE = path.join(process.cwd(), ".data", "telegram-user-session.enc");
const ALGORITHM = "aes-256-gcm";

function getKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is required to protect the Telegram user session.");
  }
  return createHash("sha256").update(secret).digest();
}

export async function loadTelegramUserSession() {
  const configuredSession = process.env.TELEGRAM_USER_SESSION?.trim();
  if (configuredSession) return configuredSession;

  try {
    const encoded = await readFile(SESSION_FILE, "utf8");
    const [ivValue, tagValue, ciphertext] = encoded.trim().split(".");
    if (!ivValue || !tagValue || !ciphertext) {
      throw new Error("Stored Telegram user session is malformed.");
    }

    const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function storeTelegramUserSession(session: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(session, "utf8"),
    cipher.final(),
  ]);
  const encoded = [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");

  await mkdir(path.dirname(SESSION_FILE), { recursive: true });
  await writeFile(SESSION_FILE, encoded, { encoding: "utf8", mode: 0o600 });
}

export async function hasStoredTelegramUserSession() {
  return Boolean(await loadTelegramUserSession());
}