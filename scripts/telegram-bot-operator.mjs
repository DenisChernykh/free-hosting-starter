import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_API_BASE_URL = "https://api.telegram.org";
const WEBHOOK_PATH = "/telegram/webhook";
const ALLOWED_UPDATES = ["message"];
export const REDACTED_WEBHOOK_URL = "[REDACTED_WEBHOOK_URL]";

/**
 * The operator intentionally has a very small surface. It can inspect the
 * current webhook, set it, or clear it; it is not a general Bot API client.
 */
export const TELEGRAM_OPERATOR_COMMANDS = ["info", "set", "clear"];

export class TelegramOperatorError extends Error {
  constructor() {
    super("Telegram operator command could not be completed.");
    this.name = "TelegramOperatorError";
  }
}

function fail() {
  throw new TelegramOperatorError();
}

function parseCommandArgs(args) {
  if (args[0] === "--") args = args.slice(1);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { command: undefined, help: true };
  }

  const [command, ...rest] = args;
  if (!TELEGRAM_OPERATOR_COMMANDS.includes(command)) fail();

  let url;
  const positional = [];
  let dropPendingUpdates = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--drop-pending-updates") {
      dropPendingUpdates = true;
      continue;
    }
    if (argument === "--url" && command === "set") {
      if (url !== undefined || index + 1 >= rest.length) fail();
      url = rest[index + 1];
      index += 1;
      continue;
    }

    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }

    // In particular, do not support --token=... or --secret=.... Secret
    // material must only come from the environment or stdin.
    fail();
  }

  if (command === "set") {
    if (url !== undefined && positional.length > 0) fail();
    if (url === undefined && positional.length === 1) url = positional[0];
    if (url === undefined || positional.length > 1) fail();
  } else if (command === "info" && dropPendingUpdates) {
    fail();
  } else if (url !== undefined || positional.length > 0) {
    fail();
  }

  return { command, dropPendingUpdates, url, help: false };
}

function printUsage(output) {
  output.write(
    `${[
      "Usage:",
      "  pnpm telegram:operator -- info",
      "  pnpm telegram:operator -- set <https-webhook-url>",
      "  pnpm telegram:operator -- set <https-webhook-url> --drop-pending-updates",
      "  pnpm telegram:operator -- clear",
      "",
      "TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_WEBHOOK_SECRET are read only from the",
      "environment or newline-delimited stdin; they are never command arguments.",
    ].join("\n")}\n`,
  );
}

function readEnvironmentSecret(environment, name) {
  const value = environment[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

async function readStdin(input) {
  if (typeof input === "string") return input;
  if (!input || input.isTTY) return "";

  const chunks = [];
  for await (const chunk of input) chunks.push(String(chunk));
  return chunks.join("");
}

async function readSecrets({ environment, input, needsWebhookSecret }) {
  let token = readEnvironmentSecret(environment, "TELEGRAM_BOT_TOKEN");
  let webhookSecret = readEnvironmentSecret(environment, "TELEGRAM_BOT_WEBHOOK_SECRET");

  if (!token || (needsWebhookSecret && !webhookSecret)) {
    const lines = (await readStdin(input))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (!token) token = lines.shift();
    if (needsWebhookSecret && !webhookSecret) webhookSecret = lines.shift();
  }

  if (!token || (needsWebhookSecret && !webhookSecret)) fail();
  return { token, webhookSecret };
}

function validateWebhookUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname !== WEBHOOK_PATH
    ) {
      fail();
    }
  } catch {
    fail();
  }
  return value;
}

function validateWebhookSecret(value) {
  if (!/^[A-Za-z0-9_-]{1,256}$/u.test(value)) fail();
  return value;
}

function replaceSecrets(value, secrets) {
  if (typeof value === "string") {
    return secrets.reduce((result, secret) => result.split(secret).join("[REDACTED]"), value);
  }
  if (Array.isArray(value)) return value.map((entry) => replaceSecrets(entry, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, replaceSecrets(entry, secrets)]),
    );
  }
  return value;
}

function projectWebhookUrl(value) {
  if (value === "") return "";
  if (typeof value !== "string") return REDACTED_WEBHOOK_URL;

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname !== WEBHOOK_PATH
    ) {
      return REDACTED_WEBHOOK_URL;
    }
    return `${url.origin}${WEBHOOK_PATH}`;
  } catch {
    return REDACTED_WEBHOOK_URL;
  }
}

function safeWebhookInfo(value, secrets) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const allowedFields = [
    "url",
    "has_custom_certificate",
    "pending_update_count",
    "ip_address",
    "last_error_date",
    "last_error_message",
    "last_synchronization_error_date",
    "max_connections",
    "allowed_updates",
  ];
  const safe = Object.fromEntries(
    allowedFields
      .filter((field) => Object.hasOwn(value, field))
      .map((field) => [field, field === "url" ? projectWebhookUrl(value[field]) : value[field]]),
  );
  return replaceSecrets(safe, secrets);
}

export function createTelegramBotApi({
  token,
  fetchImpl = globalThis.fetch,
  apiBaseUrl = DEFAULT_API_BASE_URL,
}) {
  if (typeof token !== "string" || token.trim() === "" || typeof fetchImpl !== "function") fail();
  const baseUrl = apiBaseUrl.endsWith("/") ? apiBaseUrl.slice(0, -1) : apiBaseUrl;

  return {
    async call(method, parameters) {
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/bot${token}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parameters ?? {}),
        });
      } catch {
        fail();
      }

      let envelope;
      try {
        envelope = await response.json();
      } catch {
        fail();
      }
      if (
        !response.ok ||
        !envelope ||
        typeof envelope !== "object" ||
        Array.isArray(envelope) ||
        envelope.ok !== true ||
        !("result" in envelope)
      ) {
        fail();
      }
      return envelope.result;
    },
  };
}

export async function runTelegramOperator({
  args = [],
  environment = process.env,
  input = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  fetchImpl = globalThis.fetch,
  apiBaseUrl = DEFAULT_API_BASE_URL,
} = {}) {
  try {
    const parsed = parseCommandArgs(args);
    if (parsed.help) {
      printUsage(stdout);
      return 0;
    }

    const needsWebhookSecret = parsed.command === "set";
    const secrets = await readSecrets({ environment, input, needsWebhookSecret });
    const api = createTelegramBotApi({ token: secrets.token, fetchImpl, apiBaseUrl });

    if (parsed.command === "info") {
      const info = await api.call("getWebhookInfo");
      const knownSecrets = [secrets.token, secrets.webhookSecret].filter(
        (secret) => secret !== undefined,
      );
      stdout.write(`${JSON.stringify(safeWebhookInfo(info, knownSecrets))}\n`);
      return 0;
    }

    if (parsed.dropPendingUpdates) {
      stderr.write("WARNING: this operation will permanently discard pending Telegram updates.\n");
    }

    if (parsed.command === "set") {
      await api.call("setWebhook", {
        url: validateWebhookUrl(parsed.url),
        allowed_updates: ALLOWED_UPDATES,
        drop_pending_updates: parsed.dropPendingUpdates,
        secret_token: validateWebhookSecret(secrets.webhookSecret),
      });
      stdout.write("Telegram webhook set.\n");
      return 0;
    }

    await api.call("setWebhook", {
      url: "",
      drop_pending_updates: parsed.dropPendingUpdates,
    });
    stdout.write("Telegram webhook cleared.\n");
    return 0;
  } catch {
    // Keep unexpected implementation failures safe too. Never expose the
    // provider URL, request body, or an exception that might contain a token.
    stderr.write("Telegram operator command failed.\n");
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]));
if (invokedDirectly) {
  const exitCode = await runTelegramOperator({ args: process.argv.slice(2) });
  process.exitCode = exitCode;
}
