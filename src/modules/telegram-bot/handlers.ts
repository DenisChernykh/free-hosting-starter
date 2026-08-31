import type { Bot } from "grammy";

export function registerTelegramBotHandlers(bot: Bot): void {
  bot.command("start", async (context) => {
    await context.reply("Bot is ready.");
  });
}
