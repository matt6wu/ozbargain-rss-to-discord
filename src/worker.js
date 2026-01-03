const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export default {
  async scheduled(event, env, ctx) {
    const summaryCrons = new Set([
      "0 14,17,20,23,2,5,8,11 * * *",
    ]);
    if (summaryCrons.has(event.cron)) {
      ctx.waitUntil(runSummary(env, event.cron));
      return;
    }
    ctx.waitUntil(run(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/interactions") {
      return handleDiscordInteraction(request, env, ctx);
    }
    if (url.pathname === "/run") {
      const force = url.searchParams.get("force") === "1";
      const limit = toNumber(url.searchParams.get("limit"));
      const summary = url.searchParams.get("summary") === "1";
      const result = summary
        ? await runSummary(env, "manual", { limit })
        : await run(env, { force, limit });
      return jsonResponse(result);
    }
    return new Response("ok");
  },
};

async function handleDiscordInteraction(request, env, ctx) {
  if (!env.DISCORD_PUBLIC_KEY) {
    return new Response("Missing DISCORD_PUBLIC_KEY", { status: 500 });
  }

  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (!signature || !timestamp) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await request.text();
  const isValid = await verifyDiscordSignature(
    env.DISCORD_PUBLIC_KEY,
    signature,
    timestamp + body
  );
  if (!isValid) {
    return new Response("Unauthorized", { status: 401 });
  }

  const payload = JSON.parse(body);
  if (payload.type === 1) {
    return jsonResponse({ type: 1 });
  }

  if (payload.type === 2 && payload.data?.name === "ozb") {
    // Acknowledge immediately to prevent timeout
    ctx.waitUntil(handleOzbCommand(payload, env));
    return jsonResponse({
      type: 5, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    });
  }

  return jsonResponse({
    type: 4,
    data: { content: "Unknown command.", allowed_mentions: { parse: [] } },
  });
}

async function handleOzbCommand(payload, env) {
  try {
    const rssUrl = env.RSS_URL || "https://www.ozbargain.com.au/feed";
    const xml = await fetchRss(rssUrl, env.RSS_USER_AGENT || DEFAULT_USER_AGENT);
    const items = parseRssItems(xml);
    const limit = toNumber(env.SUMMARY_LIMIT) || 15;
    const filteredItems = applyFilters(items, env).slice(0, limit).reverse(); // Oldest first, newest last

    if (!filteredItems.length) {
      await sendFollowUp(payload, {
        content: "No items found.",
        allowed_mentions: { parse: [] },
      });
      return;
    }

    const embeds = filteredItems.map((item, index) => {
      const dealPrice = item.pricing?.dealPrice;
      const originalPrice = item.pricing?.originalPrice;
      const discount = item.pricing?.discount;
      const votesPos = item.ozbMeta?.votesPos;
      const votesNeg = item.ozbMeta?.votesNeg || 0;
      const comments = item.ozbMeta?.commentCount;

      const fields = [];

      if (Number.isFinite(dealPrice)) {
        fields.push({
          name: "💰 Price",
          value: `$${dealPrice.toFixed(2)}`,
          inline: true,
        });
      }

      if (Number.isFinite(discount) && discount > 0) {
        fields.push({
          name: "📊 Discount",
          value: `${discount}%`,
          inline: true,
        });
      }

      if (Number.isFinite(votesPos)) {
        fields.push({
          name: "👍 Votes",
          value: `+${votesPos}${votesNeg > 0 ? ` / -${votesNeg}` : ""}`,
          inline: true,
        });
      }

      if (Number.isFinite(comments)) {
        fields.push({
          name: "💬 Comments",
          value: `${comments}`,
          inline: true,
        });
      }

      return {
        title: `${index + 1}. ${truncate(item.title, 200)}`,
        url: item.link,
        description: truncate(item.description, 150),
        color: 0xff6a00, // Orange for manual /ozb command
        thumbnail: item.image ? { url: item.image } : undefined,
        fields: fields.length ? fields : undefined,
      };
    });

    // Discord limit: max 10 embeds per message
    const maxEmbedsPerMessage = 10;

    // Send first batch (up to 10)
    await sendFollowUp(payload, {
      content: "🔥 **Latest OzBargain Deals**",
      embeds: embeds.slice(0, maxEmbedsPerMessage),
      allowed_mentions: { parse: [] },
    });

    // Send remaining embeds in additional messages if needed
    if (embeds.length > maxEmbedsPerMessage) {
      for (let i = maxEmbedsPerMessage; i < embeds.length; i += maxEmbedsPerMessage) {
        await sendFollowUp(payload, {
          embeds: embeds.slice(i, i + maxEmbedsPerMessage),
          allowed_mentions: { parse: [] },
        });
      }
    }
  } catch (error) {
    await sendFollowUp(payload, {
      content: `Error: ${error.message}`,
      allowed_mentions: { parse: [] },
    });
  }
}

async function sendFollowUp(payload, data) {
  const url = `https://discord.com/api/v10/webhooks/${payload.application_id}/${payload.token}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Follow-up failed: ${res.status} ${body}`);
  }
}

async function run(env, options = {}) {
  if (!env.DISCORD_WEBHOOK_URL) {
    return { ok: false, error: "Missing DISCORD_WEBHOOK_URL" };
  }

  const rssUrl = env.RSS_URL || "https://www.ozbargain.com.au/feed";
  const xml = await fetchRss(rssUrl, env.RSS_USER_AGENT || DEFAULT_USER_AGENT);
  const items = parseRssItems(xml);

  if (!items.length) {
    return { ok: true, message: "No items in feed" };
  }

  const seenLimit = toNumber(env.SEEN_GUIDS_LIMIT) || 200;
  const seen = options.force ? [] : await getSeenGuids(env);
  const lastGuid = options.force ? null : await env.OZB_KV.get("last_guid");
  const firstRunSend = toBool(env.FIRST_RUN_SEND);

  if (!seen.length && !lastGuid && !options.force && !firstRunSend) {
    await env.OZB_KV.put("last_guid", items[0].guid);
    await saveSeenGuids(env, items, seen, seenLimit);
    return { ok: true, message: "First run: stored latest guid, no send" };
  }

  const newItems = options.force
    ? items
    : collectNewItems(items, { lastGuid, seen });
  if (!newItems.length) {
    await env.OZB_KV.put("last_guid", items[0].guid);
    await saveSeenGuids(env, items, seen, seenLimit);
    return { ok: true, message: "No new items" };
  }

  const historyCount = Math.max(0, toNumber(env.HISTORY_ITEMS) || 0);
  const newSet = new Set(newItems.map((item) => item.guid));
  const historyItems =
    historyCount > 0
      ? items.filter((item) => !newSet.has(item.guid)).slice(0, historyCount)
      : [];
  const batch = newItems.concat(historyItems);

  let filteredItems = applyFilters(batch, env);
  if (options.limit && options.limit > 0) {
    filteredItems = filteredItems.slice(0, options.limit);
  }
  for (const item of filteredItems.reverse()) {
    await sendDiscord(item, env);
  }

  await env.OZB_KV.put("last_guid", items[0].guid);
  await saveSeenGuids(env, items, seen, seenLimit);

  return {
    ok: true,
    message: `Sent ${filteredItems.length} new items`,
  };
}

async function runSummary(env, cronLabel, options = {}) {
  if (!env.DISCORD_WEBHOOK_URL) {
    return { ok: false, error: "Missing DISCORD_WEBHOOK_URL" };
  }

  const rssUrl = env.RSS_URL || "https://www.ozbargain.com.au/feed";
  const xml = await fetchRss(rssUrl, env.RSS_USER_AGENT || DEFAULT_USER_AGENT);
  const items = parseRssItems(xml);

  if (!items.length) {
    return { ok: true, message: "No items in feed" };
  }

  const limit = options.limit || toNumber(env.SUMMARY_LIMIT) || 10;
  const filteredItems = applyFilters(items, env).slice(0, limit);
  if (!filteredItems.length) {
    return { ok: true, message: "No items after filters" };
  }

  await sendDiscordSummary(filteredItems, env, cronLabel);
  return {
    ok: true,
    message: `Summary sent (${filteredItems.length} items)`,
  };
}

async function fetchRss(url, userAgent) {
  const res = await fetch(url, {
    headers: {
      "user-agent": userAgent,
      "accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!res.ok) {
    throw new Error(`RSS fetch failed: ${res.status}`);
  }

  return res.text();
}

function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml))) {
    const itemXml = match[1];
    const title = getTagText(itemXml, "title");
    const link = getTagText(itemXml, "link");
    const guid = getTagText(itemXml, "guid") || link;
    const pubDate = getTagText(itemXml, "pubDate");
    const description = getTagText(itemXml, "description");
    const categories = getAllTagText(itemXml, "category");
    const ozbMeta = extractOzbMetaFromXml(itemXml);
    const mediaThumb =
      getAttrFromTag(itemXml, "media:thumbnail", "url") ||
      getAttrFromTag(itemXml, "media:content", "url");
    const image = mediaThumb || extractImageFromDescription(description) || ozbMeta.image;
    const prices = extractPrices(`${title} ${description}`);
    const pricing = buildPricing(prices);

    items.push({
      title: title.trim(),
      link: link.trim(),
      guid: guid.trim(),
      pubDate: pubDate.trim(),
      description: stripHtml(description).trim(),
      image,
      categories,
      ozbMeta,
      pricing,
    });
  }

  return items.filter((item) => item.title && item.link && item.guid);
}

function getTagText(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = xml.match(regex);
  if (!match) {
    return "";
  }

  return decodeEntities(stripCdata(match[1]).trim());
}

function getAllTagText(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const results = [];
  let match;
  while ((match = regex.exec(xml))) {
    const value = decodeEntities(stripCdata(match[1]).trim());
    if (value) {
      results.push(value);
    }
  }
  return results;
}

function stripCdata(value) {
  const match = value.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
  return match ? match[1] : value;
}

function getAttrFromTag(xml, tag, attr) {
  const regex = new RegExp(`<${tag}[^>]*>`, "i");
  const match = xml.match(regex);
  if (!match) {
    return "";
  }
  const attrRegex = new RegExp(`${attr}="([^"]+)"`, "i");
  const attrMatch = match[0].match(attrRegex);
  return attrMatch ? attrMatch[1] : "";
}

function extractImageFromDescription(description) {
  const match = description.match(/<img[^>]+src="([^">]+)"/i);
  return match ? match[1] : "";
}

function extractOzbMetaFromXml(xml) {
  const match = xml.match(/<ozb:meta\s+([^>]+?)\s*\/?>/i);
  if (!match) {
    return {
      url: "",
      image: "",
      votesPos: null,
      votesNeg: null,
      commentCount: null,
      clickCount: null,
      expiry: "",
      starting: "",
    };
  }

  const attrs = parseAttributes(match[1]);
  return {
    url: attrs.url || "",
    image: attrs.image || "",
    votesPos: toNumber(attrs["votes-pos"]),
    votesNeg: toNumber(attrs["votes-neg"]),
    commentCount: toNumber(attrs["comment-count"]),
    clickCount: toNumber(attrs["click-count"]),
    expiry: attrs.expiry || "",
    starting: attrs.starting || "",
  };
}

function parseAttributes(value) {
  const attrs = {};
  const regex = /([a-zA-Z0-9:_-]+)="([^"]*)"/g;
  let match;
  while ((match = regex.exec(value))) {
    attrs[match[1]] = decodeEntities(match[2]);
  }
  return attrs;
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function extractPrices(text) {
  const matches = text.match(/\$[0-9]+(?:\.[0-9]{1,2})?/g) || [];
  return matches.map((m) => Number(m.replace("$", ""))).filter((n) => !Number.isNaN(n));
}

function buildPricing(prices) {
  if (!prices.length) {
    return null;
  }

  const sorted = [...prices].sort((a, b) => a - b);
  const dealPrice = sorted[0];
  const originalPrice = sorted.length > 1 ? sorted[sorted.length - 1] : null;
  const discount =
    originalPrice && originalPrice > dealPrice
      ? Math.round(((originalPrice - dealPrice) / originalPrice) * 100)
      : null;

  return { dealPrice, originalPrice, discount };
}

function collectNewItems(items, state) {
  const seen = state?.seen || [];
  const lastGuid = state?.lastGuid || null;

  if (lastGuid) {
    const index = items.findIndex((item) => item.guid === lastGuid);
    if (index > -1) {
      const slice = items.slice(0, index);
      return filterUnseen(slice, seen);
    }
  }

  if (!seen.length) {
    return items;
  }
  return filterUnseen(items, seen);
}

function filterUnseen(items, seen) {
  if (!seen.length) {
    return items;
  }
  const seenSet = new Set(seen);
  return items.filter((item) => !seenSet.has(item.guid));
}

function applyFilters(items, env) {
  const include = csvToLowerSet(env.KEYWORDS_INCLUDE);
  const exclude = csvToLowerSet(env.KEYWORDS_EXCLUDE);
  const minDiscount = toNumber(env.MIN_DISCOUNT);
  const maxPrice = toNumber(env.MAX_PRICE);

  return items.filter((item) => {
    const haystack = `${item.title} ${item.description}`.toLowerCase();

    if (include.size && !hasAnyKeyword(haystack, include)) {
      return false;
    }

    if (exclude.size && hasAnyKeyword(haystack, exclude)) {
      return false;
    }

    if (minDiscount !== null) {
      const discount = item.pricing ? item.pricing.discount : null;
      if (discount === null || discount < minDiscount) {
        return false;
      }
    }

    if (maxPrice !== null) {
      const dealPrice = item.pricing ? item.pricing.dealPrice : null;
      if (dealPrice !== null && dealPrice > maxPrice) {
        return false;
      }
    }

    return true;
  });
}

function csvToLowerSet(value) {
  if (!value) {
    return new Set();
  }
  return new Set(
    value
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function hasAnyKeyword(haystack, set) {
  for (const keyword of set) {
    if (haystack.includes(keyword)) {
      return true;
    }
  }
  return false;
}

async function sendDiscord(item, env) {
  const payload = buildDiscordPayload(item, env);
  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord webhook failed: ${res.status} ${body}`);
  }
}

async function sendDiscordSummary(items, env, cronLabel) {
  const mention = env.DISCORD_USER_ID ? `<@${env.DISCORD_USER_ID}> ` : "";
  const label = cronLabel === "manual" ? "Front Page Summary (manual)" : "Front Page Summary";

  // Reverse to show oldest first, newest last
  const reversedItems = [...items].reverse();

  // Build embeds like /ozb command
  const embeds = reversedItems.map((item, index) => {
    const dealPrice = item.pricing?.dealPrice;
    const discount = item.pricing?.discount;
    const votesPos = item.ozbMeta?.votesPos;
    const votesNeg = item.ozbMeta?.votesNeg || 0;
    const comments = item.ozbMeta?.commentCount;

    const fields = [];
    if (Number.isFinite(dealPrice)) {
      fields.push({
        name: "💰 Price",
        value: `$${dealPrice.toFixed(2)}`,
        inline: true,
      });
    }
    if (Number.isFinite(discount) && discount > 0) {
      fields.push({
        name: "📊 Discount",
        value: `${discount}%`,
        inline: true,
      });
    }
    if (Number.isFinite(votesPos)) {
      fields.push({
        name: "👍 Votes",
        value: `+${votesPos}${votesNeg > 0 ? ` / -${votesNeg}` : ""}`,
        inline: true,
      });
    }
    if (Number.isFinite(comments)) {
      fields.push({
        name: "💬 Comments",
        value: `${comments}`,
        inline: true,
      });
    }

    return {
      title: `${index + 1}. ${truncate(item.title, 200)}`,
      url: item.link,
      description: truncate(item.description, 150),
      color: 0xff6a00, // Orange for summary
      thumbnail: item.image ? { url: item.image } : undefined,
      fields: fields.length ? fields : undefined,
    };
  });

  // Split into batches of 10 (Discord limit)
  const maxEmbedsPerMessage = 10;

  // First batch
  const payload1 = {
    content: `${mention}📊 **${label}**`,
    embeds: embeds.slice(0, maxEmbedsPerMessage),
  };

  const res1 = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload1),
  });

  if (!res1.ok) {
    const body = await res1.text();
    throw new Error(`Discord webhook failed: ${res1.status} ${body}`);
  }

  // Send remaining embeds if needed
  if (embeds.length > maxEmbedsPerMessage) {
    for (let i = maxEmbedsPerMessage; i < embeds.length; i += maxEmbedsPerMessage) {
      const payload = {
        embeds: embeds.slice(i, i + maxEmbedsPerMessage),
      };
      const res = await fetch(env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Discord webhook failed: ${res.status} ${body}`);
      }
    }
  }
}

function buildDiscordPayload(item, env) {
  const fields = [];
  if (Number.isFinite(item.pricing?.dealPrice)) {
    fields.push({
      name: "Deal Price",
      value: `$${item.pricing.dealPrice.toFixed(2)}`,
      inline: true,
    });
  }

  if (Number.isFinite(item.pricing?.originalPrice)) {
    fields.push({
      name: "Original Price",
      value: `$${item.pricing.originalPrice.toFixed(2)}`,
      inline: true,
    });
  }

  if (Number.isFinite(item.pricing?.discount)) {
    fields.push({
      name: "Discount",
      value: `${item.pricing.discount}%`,
      inline: true,
    });
  }

  if (item.ozbMeta?.url) {
    fields.push({
      name: "Store Link",
      value: item.ozbMeta.url,
      inline: false,
    });
  }

  if (item.categories?.length) {
    fields.push({
      name: "Category",
      value: item.categories.slice(0, 4).join(", "),
      inline: true,
    });
  }

  if (item.ozbMeta?.commentCount !== null) {
    fields.push({
      name: "Comments",
      value: `${item.ozbMeta.commentCount}`,
      inline: true,
    });
  }

  if (item.ozbMeta?.votesPos !== null) {
    const neg = item.ozbMeta.votesNeg !== null ? item.ozbMeta.votesNeg : 0;
    fields.push({
      name: "Votes",
      value: `+${item.ozbMeta.votesPos} / -${neg}`,
      inline: true,
    });
  }

  if (item.ozbMeta?.expiry) {
    fields.push({
      name: "Expiry",
      value: item.ozbMeta.expiry,
      inline: true,
    });
  }

  const mention = env.DISCORD_USER_ID ? `<@${env.DISCORD_USER_ID}> ` : "";
  const postTime = item.pubDate ? ` - Posted: ${formatDateTime(item.pubDate)}` : "";
  const content = `${mention}🚨 **NEW DEAL DETECTED**${postTime}`;

  return {
    content,
    embeds: [
      {
        title: item.title,
        url: item.link,
        description: truncate(item.description, 200),
        color: 0xed4245, // Red for new deals (automatic push)
        fields: fields.length ? fields : undefined,
        thumbnail: item.image ? { url: item.image } : undefined,
        footer: item.pubDate ? { text: item.pubDate } : undefined,
      },
    ],
  };
}

function buildSummaryPayload(items, env, cronLabel) {
  const lines = items.map((item, index) => {
    const title = truncate(item.title, 80);
    const dealPrice = item.pricing?.dealPrice;
    const price = Number.isFinite(dealPrice) ? ` — $${dealPrice.toFixed(2)}` : "";
    return `${index + 1}. [${title}](${item.link})${price}`;
  });

  const content = env.DISCORD_USER_ID ? `<@${env.DISCORD_USER_ID}>` : undefined;
  const label =
    cronLabel === "manual"
      ? "Front Page Summary (manual)"
      : "Front Page Summary";

  return {
    content,
    embeds: [
      {
        title: label,
        description: lines.join("\n"),
        color: 0xff6a00,
        footer: { text: "Source: OzBargain Front Page" },
      },
    ],
  };
}

function truncate(value, max) {
  if (!value) {
    return "";
  }
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function toBool(value) {
  if (!value) {
    return false;
  }
  return value.toString().toLowerCase() === "true";
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

function jsonResponse(data) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "content-type": "application/json" },
  });
}

async function verifyDiscordSignature(publicKeyHex, signatureHex, message) {
  try {
    const keyBytes = hexToBytes(publicKeyHex);
    const sigBytes = hexToBytes(signatureHex);
    const data = new TextEncoder().encode(message);
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    return crypto.subtle.verify("Ed25519", key, sigBytes, data);
  } catch {
    return false;
  }
}

function hexToBytes(hex) {
  const clean = hex.trim();
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

async function getSeenGuids(env) {
  const raw = await env.OZB_KV.get("seen_guids");
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveSeenGuids(env, items, seen, limit) {
  const merged = mergeSeen(items, seen, limit);
  await env.OZB_KV.put("seen_guids", JSON.stringify(merged));
}

function mergeSeen(items, seen, limit) {
  const set = new Set();
  const merged = [];

  for (const item of items) {
    if (!set.has(item.guid)) {
      set.add(item.guid);
      merged.push(item.guid);
    }
  }

  for (const guid of seen) {
    if (!set.has(guid)) {
      set.add(guid);
      merged.push(guid);
    }
  }

  return merged.slice(0, limit);
}

function formatDateTime(dateString) {
  try {
    const date = new Date(dateString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  } catch {
    return dateString;
  }
}
