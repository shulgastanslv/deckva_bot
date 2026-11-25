import "dotenv/config";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Задайте ${name} в .env`);
  }
  return value;
}

const adminIds = required("ADMIN_ID")
  .split(/[,\s]+/)
  .map((part) => Number(part))
  .filter((id) => Number.isInteger(id) && id > 0);

if (adminIds.length === 0) {
  throw new Error("ADMIN_ID должен быть числовым Telegram id");
}

export const config = {
  token: required("TG_BOT_TOKEN"),
  databaseUrl: required("DATABASE_URL"),
  adminIds: new Set(adminIds),
};

export const PAGE_SIZE = 5;
