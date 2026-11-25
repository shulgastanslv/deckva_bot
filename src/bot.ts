import {
  Bot,
  Context,
  GrammyError,
  InlineKeyboard,
  Keyboard,
  session,
  type SessionFlavor,
} from "grammy";
import { config, PAGE_SIZE } from "./config";
import {
  countPending,
  countUsers,
  deleteUser,
  getUser,
  listPending,
  listUsers,
  locksOutAdmins,
  newsAuthor,
  notifyUser,
  publishNews,
  reviewTemplate,
  searchUsers,
  setBanned,
  setRole,
  setUnlimited,
  type AdminUser,
  type PendingTemplate,
} from "./db";

const TITLE_MAX = 200;
const BODY_MAX = 4000;

type Step =
  | { type: "idle" }
  | { type: "news-title" }
  | { type: "news-body"; title: string }
  | { type: "news-confirm"; title: string; body: string }
  | { type: "dm-query" }
  | { type: "dm-title"; userId: string; label: string }
  | { type: "dm-body"; userId: string; label: string; title: string }
  | {
      type: "dm-confirm";
      userId: string;
      label: string;
      title: string;
      body: string;
    };

type SessionData = { step: Step };
type BotContext = Context & SessionFlavor<SessionData>;

const menu = new Keyboard()
  .text("Новые шаблоны")
  .text("Пользователи")
  .row()
  .text("Новость")
  .text("Сообщение")
  .resized()
  .persistent();

const when = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

function preview(value: string, max: number): string {
  const clean = value.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

function clampOffset(offset: number, total: number): number {
  if (total <= 0) return 0;
  const max = Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE;
  return Math.min(Math.max(0, offset), max);
}

function reset(ctx: BotContext) {
  ctx.session.step = { type: "idle" };
}

function userLabel(user: { name: string | null; email: string }): string {
  const name = user.name?.trim();
  return name ? `${name} · ${user.email}` : user.email;
}

function formatTemplate(item: PendingTemplate, index: number): string {
  const author = item.authorName?.trim() || "Без имени";
  const submitted = item.submittedAt
    ? when.format(item.submittedAt)
    : "дата не указана";
  const lines = [
    `<b>${index}. ${esc(clip(item.title, 80))}</b>`,
    `${esc(author)} · ${esc(item.authorEmail)}`,
    [
      item.category ? esc(item.category) : "без категории",
      `${item.slideCount} сл.`,
      item.aspectRatio,
      submitted,
    ].join(" · "),
  ];
  if (item.description) {
    lines.push(esc(clip(item.description, 180)));
  }
  if (item.keyMoments.length > 0) {
    lines.push(esc(clip(item.keyMoments.slice(0, 3).join(" · "), 140)));
  }
  return lines.join("\n");
}

async function templatesView(offset: number): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const total = await countPending();
  const safe = clampOffset(offset, total);
  const items = total === 0 ? [] : await listPending(PAGE_SIZE, safe);
  const page = Math.floor(safe / PAGE_SIZE) + 1;

  const keyboard = new InlineKeyboard();
  if (items.length === 0) {
    keyboard.text("Обновить", "p:0");
    return {
      text: "<b>Новые шаблоны</b>\nНа ревью ничего нет.",
      keyboard,
    };
  }

  const body = items
    .map((item, i) => formatTemplate(item, safe + i + 1))
    .join("\n\n");

  for (const item of items) {
    const label = clip(item.title, 18);
    keyboard
      .text(`Принять ${label}`, `a:${item.id}:${safe}`)
      .text("Отклонить", `x:${item.id}:${safe}`)
      .row();
  }

  if (safe > 0) keyboard.text("← Назад", `p:${safe - PAGE_SIZE}`);
  if (safe + PAGE_SIZE < total) keyboard.text("Дальше →", `p:${safe + PAGE_SIZE}`);
  keyboard.row().text("Обновить", `p:${safe}`);

  return {
    text: `<b>Новые шаблоны: ${total}</b>\nПоследние на ревью · стр. ${page}/${pageCount(total)}\n\n${body}`,
    keyboard,
  };
}

function formatUser(user: AdminUser, index: number): string {
  const name = user.name?.trim() || "Без имени";
  const signedIn = user.lastSignedInAt
    ? when.format(user.lastSignedInAt)
    : "ещё не входил";
  return [
    `<b>${index}. ${esc(clip(name, 60))}</b> · ${esc(user.role)}${user.banned ? " · бан" : ""}`,
    esc(user.email),
    `проектов ${user.projectCount} · генераций сегодня ${user.generationsUsedToday} · безлимит ${user.unlimitedGenerations ? "да" : "нет"}`,
    `вход ${signedIn} · с ${when.format(user.createdAt)}`,
  ].join("\n");
}

function userCardText(user: AdminUser): string {
  const name = user.name?.trim() || "Без имени";
  const signedIn = user.lastSignedInAt
    ? when.format(user.lastSignedInAt)
    : "ещё не входил";
  return [
    `<b>${esc(clip(name, 80))}</b>`,
    esc(user.email),
    `роль ${esc(user.role)} · бан ${user.banned ? "да" : "нет"} · безлимит ${user.unlimitedGenerations ? "да" : "нет"}`,
    `проектов ${user.projectCount} · генераций сегодня ${user.generationsUsedToday}`,
    `вход ${signedIn} · с ${when.format(user.createdAt)}`,
  ].join("\n");
}

function userKeyboard(user: AdminUser, offset: number): InlineKeyboard {
  const id = user.id;
  return new InlineKeyboard()
    .text(user.banned ? "Разбанить" : "Бан", `ub:${offset}:${id}`)
    .text(user.role === "ADMIN" ? "Снять админа" : "Сделать админом", `ur:${offset}:${id}`)
    .row()
    .text(
      user.unlimitedGenerations ? "Выключить безлимит" : "Включить безлимит",
      `uu:${offset}:${id}`,
    )
    .row()
    .text("Написать", `um:${offset}:${id}`)
    .text("Удалить", `ud:${offset}:${id}`)
    .row()
    .text("К списку", `u:${offset}`);
}

async function usersView(offset: number): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const total = await countUsers();
  const safe = clampOffset(offset, total);
  const items = total === 0 ? [] : await listUsers(PAGE_SIZE, safe);
  const page = Math.floor(safe / PAGE_SIZE) + 1;
  const keyboard = new InlineKeyboard();

  if (items.length === 0) {
    keyboard.text("Обновить", "u:0");
    return { text: "<b>Пользователи: 0</b>", keyboard };
  }

  const body = items
    .map((user, i) => formatUser(user, safe + i + 1))
    .join("\n\n");

  for (const [index, user] of items.entries()) {
    const name = user.name?.trim() || user.email;
    keyboard.text(`${safe + index + 1}. ${clip(name, 28)}`, `uo:${safe}:${user.id}`).row();
  }

  if (safe > 0) keyboard.text("← Назад", `u:${safe - PAGE_SIZE}`);
  if (safe + PAGE_SIZE < total) keyboard.text("Дальше →", `u:${safe + PAGE_SIZE}`);
  keyboard.row().text("Обновить", `u:${safe}`);

  return {
    text: `<b>Пользователи: ${total}</b>\nСтр. ${page}/${pageCount(total)}. Кнопка открывает карточку.\n\n${body}`,
    keyboard,
  };
}

async function userCardView(
  offset: number,
  id: string,
): Promise<{ text: string; keyboard: InlineKeyboard } | null> {
  const user = await getUser(id);
  if (!user) return null;
  return { text: userCardText(user), keyboard: userKeyboard(user, offset) };
}

async function show(
  ctx: {
    reply: (text: string, extra?: object) => Promise<unknown>;
    editMessageText?: (text: string, extra?: object) => Promise<unknown>;
    callbackQuery?: unknown;
  },
  view: { text: string; keyboard: InlineKeyboard },
) {
  const extra = { parse_mode: "HTML" as const, reply_markup: view.keyboard };
  if (ctx.callbackQuery && ctx.editMessageText) {
    try {
      await ctx.editMessageText(view.text, extra);
      return;
    } catch (err) {
      const description = err instanceof GrammyError ? err.description : "";
      if (description.includes("message is not modified")) return;
    }
  }
  await ctx.reply(view.text, extra);
}

async function toast(ctx: BotContext, text: string) {
  await ctx.answerCallbackQuery({ text: clip(text, 180) }).catch(() => undefined);
}

function isAdmin(id: number | undefined): boolean {
  return id != null && config.adminIds.has(id);
}

function takeTitle(text: string): string | null {
  const title = text.trim();
  if (!title || title.length > TITLE_MAX) return null;
  return title;
}

function takeBody(text: string): string | null {
  const body = text.trim();
  if (!body || body.length > BODY_MAX) return null;
  return body;
}

export const bot = new Bot<BotContext>(config.token);

bot.use(async (ctx, next) => {
  if (isAdmin(ctx.from?.id)) {
    await next();
    return;
  }
  console.log(`отклонён доступ: ${ctx.from?.id ?? "нет id"}`);
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: "Нет доступа" });
    return;
  }
  if (ctx.message) await ctx.reply("Нет доступа.");
});

bot.use(session({ initial: (): SessionData => ({ step: { type: "idle" } }) }));

bot.command("start", async (ctx) => {
  reset(ctx);
  await ctx.reply(
    "Админка Deckva.\nШаблоны, пользователи, новость всем и сообщение одному — в колокольчик на сайте.",
    { reply_markup: menu },
  );
});

bot.command("cancel", async (ctx) => {
  reset(ctx);
  await ctx.reply("Отменено.", { reply_markup: menu });
});

bot.hears("Новые шаблоны", async (ctx) => {
  reset(ctx);
  try {
    await show(ctx, await templatesView(0));
  } catch (err) {
    console.error(err);
    await ctx.reply("Не получилось прочитать базу.", { reply_markup: menu });
  }
});

bot.hears("Пользователи", async (ctx) => {
  reset(ctx);
  try {
    await show(ctx, await usersView(0));
  } catch (err) {
    console.error(err);
    await ctx.reply("Не получилось прочитать базу.", { reply_markup: menu });
  }
});

bot.hears("Новость", async (ctx) => {
  ctx.session.step = { type: "news-title" };
  await ctx.reply(
    "Заголовок новости.\nОна сохранится в ленте и придёт всем в колокольчик на сайте.\n/cancel — отмена.",
    { reply_markup: menu },
  );
});

bot.hears("Сообщение", async (ctx) => {
  ctx.session.step = { type: "dm-query" };
  await ctx.reply(
    "Кому написать? Пришли email или имя.\nСообщение появится в колокольчике на сайте.\n/cancel — отмена.",
    { reply_markup: menu },
  );
});

bot.callbackQuery(/^p:(\d+)$/, async (ctx) => {
  try {
    await ctx.answerCallbackQuery();
    await show(ctx, await templatesView(Number(ctx.match[1])));
  } catch (err) {
    console.error(err);
    await toast(ctx, "Не получилось прочитать базу");
  }
});

bot.callbackQuery(/^u:(\d+)$/, async (ctx) => {
  try {
    await ctx.answerCallbackQuery();
    await show(ctx, await usersView(Number(ctx.match[1])));
  } catch (err) {
    console.error(err);
    await toast(ctx, "Не получилось прочитать базу");
  }
});

bot.callbackQuery(/^([ax]):([^:]+):(\d+)$/, async (ctx) => {
  const status = ctx.match[1] === "a" ? "APPROVED" : "REJECTED";
  try {
    const title = await reviewTemplate(ctx.match[2], status);
    await ctx.answerCallbackQuery({
      text: title
        ? status === "APPROVED"
          ? `Принят: ${clip(title, 40)}`
          : `Отклонён: ${clip(title, 40)}`
        : "Уже обработан",
    });
    await show(ctx, await templatesView(Number(ctx.match[3])));
  } catch (err) {
    console.error(err);
    await toast(ctx, "Не получилось обновить шаблон");
  }
});

async function showCard(ctx: BotContext, offset: number, id: string) {
  const view = await userCardView(offset, id);
  if (!view) {
    await toast(ctx, "Пользователь не найден");
    await show(ctx, await usersView(offset));
    return;
  }
  await ctx.answerCallbackQuery().catch(() => undefined);
  await show(ctx, view);
}

bot.callbackQuery(/^uo:(\d+):([^:]+)$/, async (ctx) => {
  try {
    await showCard(ctx, Number(ctx.match[1]), ctx.match[2]);
  } catch (err) {
    console.error(err);
    await toast(ctx, "Не получилось открыть пользователя");
  }
});

bot.callbackQuery(/^ub:(\d+):([^:]+)$/, async (ctx) => {
  const offset = Number(ctx.match[1]);
  const id = ctx.match[2];
  try {
    const user = await getUser(id);
    if (!user) {
      await toast(ctx, "Пользователь не найден");
      await show(ctx, await usersView(offset));
      return;
    }
    if (await locksOutAdmins(user, "ban")) {
      await toast(ctx, "Это последний админ");
      return;
    }
    const next = await setBanned(id, !user.banned);
    await toast(ctx, user.banned ? "Бан снят" : "Забанен");
    if (!next) {
      await show(ctx, await usersView(offset));
      return;
    }
    await show(ctx, { text: userCardText(next), keyboard: userKeyboard(next, offset) });
  } catch (err) {
    console.error(err);
    await toast(ctx, "Не получилось обновить бан");
  }
});

bot.callbackQuery(/^ur:(\d+):([^:]+)$/, async (ctx) => {
  const offset = Number(ctx.match[1]);
  const id = ctx.match[2];
  try {
    const user = await getUser(id);
    if (!user) {
      await toast(ctx, "Пользователь не найден");
      await show(ctx, await usersView(offset));
      return;
    }
    const nextRole = user.role === "ADMIN" ? "USER" : "ADMIN";
    if (nextRole === "USER" && (await locksOutAdmins(user, "demote"))) {
      await toast(ctx, "Это последний админ");
      return;
    }
    const next = await setRole(id, nextRole);
    await toast(ctx, nextRole === "ADMIN" ? "Теперь админ" : "Роль снята");
    if (!next) {
      await show(ctx, await usersView(offset));
      return;
    }
    await show(ctx, { text: userCardText(next), keyboard: userKeyboard(next, offset) });
  } catch (err) {
    console.error(err);
    await toast(ctx, "Не получилось сменить роль");
  }
});

bot.callbackQuery(/^uu:(\d+):([^:]+)$/, async (ctx) => {
  const offset = Number(ctx.match[1]);
  const id = ctx.match[2];
  try {
    const user = await getUser(id);
    if (!user) {
      await toast(ctx, "Пользователь не найден");
      await show(ctx, await usersView(offset));
      return;
    }
    const next = await setUnlimited(id, !user.unlimitedGenerations);
    await toast(ctx, user.unlimitedGenerations ? "Безлимит выключен" : "Безлимит включён");
    if (!next) {
      await show(ctx, await usersView(offset));
      return;
    }
    await show(ctx, { text: userCardText(next), keyboard: userKeyboard(next, offset) });
  } catch (err) {
    console.error(err);
    await toast(ctx, "Не получилось обновить лимит");
  }
});

bot.callbackQuery(/^ud:(\d+):([^:]+)$/, async (ctx) => {
  const offset = Number(ctx.match[1]);
  const id = ctx.match[2];
  try {
    const user = await getUser(id);
    if (!user) {
      await toast(ctx, "Пользователь не найден");
      await show(ctx, await usersView(offset));
      return;
    }
    if (await locksOutAdmins(user, "delete")) {
      await toast(ctx, "Это последний админ");
      return;
    }
    await ctx.answerCallbackQuery();
    await show(ctx, {
      text: `Удалить <b>${esc(user.email)}</b>?\nПроекты и связанные данные удалятся.`,
      keyboard: new InlineKeyboard()
        .text("Удалить навсегда", `uy:${offset}:${id}`)
        .text("Отмена", `uo:${offset}:${id}`),
    });
  } catch (err) {
    console.error(err);
    await toast(ctx, "Не получилось подготовить удаление");
  }
});

bot.callbackQuery(/^uy:(\d+):([^:]+)$/, async (ctx) => {
  const offset = Number(ctx.match[1]);
  const id = ctx.match[2];
  try {
    const result = await deleteUser(id);
    if (!result.ok) {
      const text =
        result.reason === "last-admin"
          ? "Это последний админ"
          : result.reason === "linked"
            ? "Не удалось удалить: есть связанные данные"
            : "Пользователь не найден";
      await toast(ctx, text);
      if (result.reason === "missing") await show(ctx, await usersView(offset));
      return;
    }
    await toast(ctx, `Удалён: ${clip(result.email, 40)}`);
    await show(ctx, await usersView(offset));
  } catch (err) {
    console.error(err);
    await toast(ctx, "Не получилось удалить");
  }
});

bot.callbackQuery(/^um:(\d+):([^:]+)$/, async (ctx) => {
  try {
    const user = await getUser(ctx.match[2]);
    if (!user) {
      await toast(ctx, "Пользователь не найден");
      return;
    }
    ctx.session.step = {
      type: "dm-title",
      userId: user.id,
      label: userLabel(user),
    };
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Сообщение для ${esc(userLabel(user))}.\nПришли заголовок.\n/cancel — отмена.`,
      { parse_mode: "HTML", reply_markup: menu },
    );
  } catch (err) {
    console.error(err);
    await toast(ctx, "Не получилось начать сообщение");
  }
});

bot.callbackQuery(/^pk:([^:]+)$/, async (ctx) => {
  try {
    const user = await getUser(ctx.match[1]);
    if (!user) {
      await toast(ctx, "Пользователь не найден");
      return;
    }
    ctx.session.step = {
      type: "dm-title",
      userId: user.id,
      label: userLabel(user),
    };
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Сообщение для ${esc(userLabel(user))}.\nПришли заголовок.\n/cancel — отмена.`,
      { parse_mode: "HTML", reply_markup: menu },
    );
  } catch (err) {
    console.error(err);
    await toast(ctx, "Не получилось выбрать пользователя");
  }
});

bot.callbackQuery("nw:no", async (ctx) => {
  reset(ctx);
  await ctx.answerCallbackQuery({ text: "Отменено" });
  await ctx.editMessageText("Новость отменена.").catch(() => undefined);
});

bot.callbackQuery("dm:no", async (ctx) => {
  reset(ctx);
  await ctx.answerCallbackQuery({ text: "Отменено" });
  await ctx.editMessageText("Сообщение отменено.").catch(() => undefined);
});

bot.callbackQuery("nw:ok", async (ctx) => {
  const step = ctx.session.step;
  if (step.type !== "news-confirm") {
    await toast(ctx, "Черновик устарел");
    return;
  }
  reset(ctx);
  try {
    const result = await publishNews(step.title, step.body);
    await ctx.answerCallbackQuery({ text: "Опубликовано" });
    await ctx.editMessageText(
      `<b>Новость опубликована</b>\n${esc(step.title)}\n\nВ колокольчик: ${result.recipients}\nАвтор: ${esc(result.author)}`,
      { parse_mode: "HTML" },
    );
  } catch (err) {
    ctx.session.step = step;
    console.error(err);
    const text =
      err instanceof Error && err.message === "NO_ADMIN"
        ? "В базе нет пользователя с ролью ADMIN"
        : "Не получилось опубликовать";
    await toast(ctx, text);
  }
});

bot.callbackQuery("dm:ok", async (ctx) => {
  const step = ctx.session.step;
  if (step.type !== "dm-confirm") {
    await toast(ctx, "Черновик устарел");
    return;
  }
  reset(ctx);
  try {
    const sent = await notifyUser(step.userId, step.title, step.body);
    if (!sent) {
      await toast(ctx, "Пользователь не найден");
      await ctx.editMessageText("Пользователь уже удалён.").catch(() => undefined);
      return;
    }
    await ctx.answerCallbackQuery({ text: "Отправлено" });
    await ctx.editMessageText(
      `<b>Сообщение отправлено</b>\n${esc(step.label)}\n${esc(step.title)}`,
      { parse_mode: "HTML" },
    );
  } catch (err) {
    ctx.session.step = step;
    console.error(err);
    await toast(ctx, "Не получилось отправить");
  }
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  const step = ctx.session.step;

  if (step.type === "idle") {
    await ctx.reply("Кнопки внизу: шаблоны, пользователи, новость или сообщение.", {
      reply_markup: menu,
    });
    return;
  }

  if (text.startsWith("/")) {
    reset(ctx);
    await ctx.reply("Отменено.", { reply_markup: menu });
    return;
  }

  try {
    await handleDraft(ctx, step, text);
  } catch (err) {
    console.error(err);
    await ctx.reply("Не получилось прочитать базу. Черновик на месте, можно продолжить.", {
      reply_markup: menu,
    });
  }
});

async function handleDraft(ctx: BotContext, step: Exclude<Step, { type: "idle" }>, text: string) {

  if (step.type === "news-title" || step.type === "dm-title") {
    const title = takeTitle(text);
    if (!title) {
      await ctx.reply(`Нужен заголовок до ${TITLE_MAX} символов.`);
      return;
    }
    ctx.session.step =
      step.type === "news-title"
        ? { type: "news-body", title }
        : { type: "dm-body", userId: step.userId, label: step.label, title };
    await ctx.reply("Теперь текст сообщения.");
    return;
  }

  if (step.type === "news-body" || step.type === "dm-body") {
    const body = takeBody(text);
    if (!body) {
      await ctx.reply(`Нужен текст до ${BODY_MAX} символов.`);
      return;
    }
    if (step.type === "news-body") {
      const [total, author] = await Promise.all([countUsers(), newsAuthor()]);
      ctx.session.step = { type: "news-confirm", title: step.title, body };
      await ctx.reply(
        `<b>Опубликовать новость?</b>\n<b>${esc(step.title)}</b>\n${esc(preview(body, 1200))}\n\nПолучат все: ${total}\nАвтор: ${author ? esc(author.label) : "нет админа в базе"}`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("Опубликовать", "nw:ok")
            .text("Отмена", "nw:no"),
        },
      );
      return;
    }
    ctx.session.step = {
      type: "dm-confirm",
      userId: step.userId,
      label: step.label,
      title: step.title,
      body,
    };
    await ctx.reply(
      `<b>Отправить?</b>\n${esc(step.label)}\n<b>${esc(step.title)}</b>\n${esc(preview(body, 1200))}`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("Отправить", "dm:ok")
          .text("Отмена", "dm:no"),
      },
    );
    return;
  }

  if (step.type === "dm-query") {
    const found = await searchUsers(text, 9);
    if (found.length === 0) {
      await ctx.reply("Никого не нашёл. Пришли другой email или имя.");
      return;
    }
    if (found.length === 1) {
      const user = found[0];
      if (!user) return;
      ctx.session.step = {
        type: "dm-title",
        userId: user.id,
        label: userLabel(user),
      };
      await ctx.reply(
        `Сообщение для ${esc(userLabel(user))}.\nПришли заголовок.`,
        { parse_mode: "HTML" },
      );
      return;
    }
    const keyboard = new InlineKeyboard();
    for (const user of found.slice(0, 8)) {
      keyboard.text(clip(userLabel(user), 40), `pk:${user.id}`).row();
    }
    const more = found.length > 8 ? "\nПоказаны первые 8, уточни запрос." : "";
    await ctx.reply(`Кого из них?${more}`, { reply_markup: keyboard });
    return;
  }

  await ctx.reply("Нажми кнопку под предыдущим сообщением или /cancel.");
}

bot.catch((err) => {
  console.error("bot error:", err);
});
