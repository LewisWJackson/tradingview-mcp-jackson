// Telegram notifications — extracted from server.mjs (pure; no shared state).
export async function sendTelegram(token, chatId, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    return r.json();
  } catch (e) { return { ok: false, description: e.message }; }
}
