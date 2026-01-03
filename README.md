# OzBargain RSS Worker

Cloudflare Worker that monitors the OzBargain RSS feed and pushes new deals to Discord via webhook.

## Project goals

- Monitor OzBargain RSS feed on a schedule
- Notify to phone (via Discord) with rich content
- Avoid IP bans by using a reasonable polling interval and normal User-Agent
- Keep state so only new deals are sent
- Allow DIY filters and formatting tweaks

## How it works

1. Cron Trigger runs the Worker every 15 minutes.
2. Worker fetches the RSS feed with a browser-like User-Agent.
3. RSS is parsed; each item is normalized into a deal object.
4. Recent GUIDs are stored in KV (`seen_guids`) to avoid repeat pushes when the front page rotates.
5. When new items exist:
   - Send all new items
   - Add the next 3 most recent older items as context
6. Pushes are sent to Discord Webhook with a rich embed card.

## Current push logic (simple summary)

- Every 15 minutes, the Worker checks the Front Page RSS feed.
- It uses `last_guid` and `seen_guids` to avoid repeats even if the front page rotates.
- Only items not previously seen are considered "new" and sent.
- Optionally attaches `HISTORY_ITEMS` older items as context.
- After sending, it updates `seen_guids` so the same items are not sent again.

## Notification content

Each Discord embed includes:

- Title + OzBargain link
- Thumbnail image (from `ozb:meta image` or RSS)
- Description snippet
- Deal price / original price / discount (best-effort parse)
- Store link (from `ozb:meta url`)
- Categories (up to 4)
- Comment count and votes
- Expiry time (if present)
- Publish date (footer)

## Example payload (Discord Webhook)

```json
{
  "content": "<@YOUR_DISCORD_USER_ID>",
  "embeds": [
    {
      "title": "Moto Tag 1 Pack $25 @ Harvey Norman",
      "url": "https://www.ozbargain.com.au/node/942905",
      "description": "Never lose track of important items again. Just attach a moto tag...",
      "color": 16737280,
      "thumbnail": {
        "url": "https://files.ozbargain.com.au/n/05/942905l.jpg?h=e62c899b"
      },
      "fields": [
        { "name": "Deal Price", "value": "$25.00", "inline": true },
        { "name": "Store Link", "value": "https://www.harveynorman.com.au/...", "inline": false },
        { "name": "Category", "value": "Electrical & Electronics", "inline": true },
        { "name": "Comments", "value": "0", "inline": true },
        { "name": "Votes", "value": "+3 / -0", "inline": true }
      ],
      "footer": { "text": "Sat, 03 Jan 2026 00:48:44 +1100" }
    }
  ]
}
```

## Setup

1. Create a KV namespace (prod + preview):

```bash
wrangler kv namespace create OZB_KV
wrangler kv namespace create OZB_KV --preview
```

2. Put the returned IDs into `wrangler.toml`:

```toml
kv_namespaces = [
  { binding = "OZB_KV", id = "YOUR_KV_ID", preview_id = "YOUR_KV_PREVIEW_ID" }
]
```

3. Add secrets:
   - `DISCORD_WEBHOOK_URL` (required)
   - `DISCORD_USER_ID` (optional, for @mention)

```bash
wrangler secret put DISCORD_WEBHOOK_URL
wrangler secret put DISCORD_USER_ID
```

4. Configure variables in `wrangler.toml`:
   - `RSS_URL` (default `https://www.ozbargain.com.au/feed` for Front Page Deals)
   - `FIRST_RUN_SEND` (`true` to send on first run)
   - `HISTORY_ITEMS` (default `3`)
   - `SUMMARY_LIMIT` (default `15`)
   - `SEEN_GUIDS_LIMIT` (default `200`, remembers recently sent items)
   - Optional filters: `KEYWORDS_INCLUDE`, `KEYWORDS_EXCLUDE`, `MIN_DISCOUNT`, `MAX_PRICE`

5. Deploy:

```bash
wrangler deploy
```

## Secrets and config

Do not store the Discord webhook URL in the repository. Use Wrangler secrets instead:

```bash
wrangler secret put DISCORD_WEBHOOK_URL
```

Optional (for @mention in Discord):

```bash
wrangler secret put DISCORD_USER_ID
```

For the `/ozb` slash command (Discord bot), also set:

```bash
wrangler secret put DISCORD_PUBLIC_KEY
```

If you want to override the feed URL or other settings, edit `wrangler.toml`:

- `RSS_URL` (default: `https://www.ozbargain.com.au/feed`)
- `FIRST_RUN_SEND` (`true` to send on first run)
- `HISTORY_ITEMS` (default: `3`)
- `SUMMARY_LIMIT` (default: `15`)
- `SEEN_GUIDS_LIMIT` (default: `200`)
- `KEYWORDS_INCLUDE`, `KEYWORDS_EXCLUDE`, `MIN_DISCOUNT`, `MAX_PRICE`

## Troubleshooting

If Wrangler shows an error like:

```
A request to the Cloudflare API (/memberships) failed. Unable to authenticate request [code: 10001]
```

Add your Cloudflare `account_id` to `wrangler.toml` (or export `CLOUDFLARE_ACCOUNT_ID`). This avoids Wrangler calling the `/memberships` endpoint when an account-scoped API token is used.

Example:

```toml
account_id = "your-account-id"
```

## Manual trigger

Call the worker at `/run` to force a check:

```bash
curl https://<your-worker-url>/run
```

### Force a test push

If you want to test pushes without waiting for new deals, call:

```bash
curl "https://<your-worker-url>/run?force=1"
```

This ignores `last_guid` and sends the latest items plus the configured history items.

To send only one item for testing:

```bash
curl "https://<your-worker-url>/run?force=1&limit=1"
```

### Daily summary pushes

The Worker is configured to send a Front Page summary every 3 hours based on AEST.

Summary size is controlled by `SUMMARY_LIMIT` (default 15).

You can manually trigger a summary:

```bash
curl "https://<your-worker-url>/run?summary=1&limit=10"
```

## Slash command (/ozb)

This Worker supports a Discord slash command that returns the latest Front Page deals with rich formatting.

### Features

When you type `/ozb` in Discord, you'll receive:

- **Rich embed cards** for each deal with OzBargain's signature orange color
- **Thumbnail images** for visual identification
- **Deal information**:
  - 💰 Deal price
  - 📊 Discount percentage
  - 👍👎 Vote counts (upvotes/downvotes)
  - 💬 Comment count
- **Clickable titles** that link directly to the deal
- **Description preview** (first 150 characters)
- **Default: 15 deals** (configurable via `SUMMARY_LIMIT`)

### Setup Steps

1. Create a Discord Application + Bot at https://discord.com/developers/applications
2. Copy the **Application ID** and **Public Key**.
3. Set the **Interactions Endpoint URL** to:

```
https://<your-worker-url>/interactions
```

4. Set the public key as a secret:

```bash
wrangler secret put DISCORD_PUBLIC_KEY
```

5. Register the slash command (guild scope for faster updates):

```bash
curl -X POST "https://discord.com/api/v10/applications/<APP_ID>/guilds/<GUILD_ID>/commands" \
  -H "Authorization: Bot <BOT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"ozb","description":"Show latest OzBargain Front Page deals"}'
```

6. Invite the bot to your server with the `applications.commands` scope.

### Usage

Type `/ozb` in Discord to receive the latest Front Page deals (top 15 by default).


## Daily summaries

Daily summaries are sent at:

- 12:00 AEST/AEDT (UTC 01:00)
- 18:00 AEST/AEDT (UTC 07:00)

You can change the cron schedule in `wrangler.toml` under `[triggers]`.

## Reset state (re-send latest)

If you want to force the Worker to treat the latest item as new:

```bash
wrangler kv key delete last_guid --namespace-id YOUR_KV_ID --remote
```

Then call:

```bash
curl "https://<your-worker-url>/run"
```

## Known gotcha: missing price

Some feed items do not include a price. The Worker treats price fields as optional and avoids formatting if missing. If you customize output, keep this in mind to avoid runtime errors.

## Front Page vs All Deals

- `https://www.ozbargain.com.au/feed` = Front Page Deals (curated)
- `https://www.ozbargain.com.au/deals/feed` = All new deals

Pick the URL you want in `RSS_URL`.

## Security notes

- Do not commit tokens or webhook URLs.
- If a token or webhook is exposed, revoke and re-create it.

## Notes

- Cron is set to run every 15 minutes in `wrangler.toml`.
- First run stores the latest GUID and skips sending, unless `FIRST_RUN_SEND=true`.
