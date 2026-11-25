import { bot } from "./bot";
import { pool } from "./db";

await pool.query("SELECT 1");

process.once("SIGINT", () => {
  void bot.stop();
});
process.once("SIGTERM", () => {
  void bot.stop();
});

await bot.start({
  onStart: (me) => {
    console.log(`@${me.username} запущен`);
  },
});

await pool.end();
