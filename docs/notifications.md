# Participant notification service

This document is the bot-side contract and operations guide for Track the Hack
participant notifications. The Track repository's
[`docs/NOTIFICATIONS.md`](https://github.com/HacktheHill/track-the-hack/blob/main/docs/NOTIFICATIONS.md)
is authoritative for participant preferences, cohort operation, real-provider
end-to-end acceptance, send-confirmation boundaries, and final completion criteria.

## Ownership

The bot is the sole owner of Discord identities. Track sends opaque Hacker IDs and
never receives Discord IDs, usernames, or provider error bodies. The bot resolves a
Hacker through `discord_participant_links`, sends the DM with mentions disabled, and
returns one safe outcome for the supplied delivery UUID.

The notification migration creates `notification_delivery_receipts`. A receipt stores
the stable Track delivery UUID, Hacker ID, content hash, internal status, attempt
count, bounded failure code, and—only inside the bot database—the Discord message ID
needed for operational evidence. Do not expose or log that provider ID.

## Signed endpoints

Both endpoints accept JSON only and require:

- `x-track-the-hack-timestamp`: ten-digit Unix seconds within five minutes of the bot
  clock; and
- `x-track-the-hack-signature`: lowercase hex HMAC-SHA256 using
  `INTERNAL_API_SECRET` and the endpoint-specific domain.

The signature inputs are:

```text
discord-participant-links-status:v1:TIMESTAMP.EXACT_JSON_BODY
discord-notifications-deliver:v1:TIMESTAMP.EXACT_JSON_BODY
```

These domains are intentionally separate from
`discord-complete:v1:TIMESTAMP.EXACT_JSON_BODY`, which authenticates verification.
Never implement a generic interchangeable `timestamp.body` signature.

### `POST /participant-links/status`

The strict body contains at most 500 valid Hacker IDs:

```json
{ "hackerIds": ["opaque-hacker-id"] }
```

The response repeats each Hacker ID with only `linked: true|false`. It never returns a
Discord identifier. An invalid signature returns `403`; malformed or oversized input
returns `400`.

### `POST /notifications/deliver`

The strict body contains 1–50 deliveries. Every delivery has a UUID, valid Hacker ID,
and trimmed 1–500-character body:

```json
{
	"deliveries": [
		{
			"id": "00000000-0000-4000-8000-000000000000",
			"hackerId": "opaque-hacker-id",
			"content": "Exact bilingual message"
		}
	]
}
```

The bot sends with `allowedMentions: { parse: [] }`. It returns only the UUID and one
of:

- `sent`;
- `not_linked`;
- `dm_unavailable`;
- `temporary_failure`; or
- `uncertain`.

It returns `503` before processing when readiness is false, `403` for an invalid or
stale signature, `400` for malformed input, and `409` when a delivery UUID is reused
for another Hacker or content hash.

## Idempotency and uncertainty

`beginNotificationDelivery` reserves a new UUID before the Discord API call. A
confirmed `sent` receipt is returned on replay without another DM. A failed transient
receipt may be reclaimed with the same UUID. Reusing an ID with different content or
another Hacker conflicts.

A receipt still in `sending` when it is seen again is converted to `uncertain`. An
exception with no Discord error code is also recorded as `uncertain`, because the API
may have accepted the DM before the caller observed the result. Track must not retry
that state automatically. The organiser follows the deliberate review procedure in
the Track notification runbook.

Discord error `50007` maps to `dm_unavailable`. Other identified Discord errors map to
`temporary_failure`. Provider error objects and DM contents are never included in the
HTTP response or application log.

## Migration, readiness, and deployment

For managed production migrations:

1. Back up the bot PostgreSQL database and verify the backup job succeeded.
2. Run `npm run migrate:db` through the reviewed migration job.
3. Confirm the job succeeded before deploying Track's notification UI.
4. Keep `VERIFICATION_RUN_MIGRATIONS=false` on the production runtime.
5. Deploy the immutable bot commit-SHA image and wait for the new revision to be
   healthy before deploying Track.

Bot readiness requires the Discord client and the verification store, including both
`discord_participant_links` and `notification_delivery_receipts`. A missing receipt
table must fail readiness instead of allowing non-idempotent delivery.

The bot and Track must have the same `INTERNAL_API_SECRET`, but operators should
compare secret references or hashes without printing values. Track's
`DISCORD_BOT_URL` must resolve through the private Container Apps network. Notification
failure must not require making either service publicly accessible.

## Verification

Run before merge and again for the released commit:

```sh
npm ci
npm test
```

The suite exercises signature domains, stale/bad signatures, content type and payload
bounds, link-status privacy, successful idempotent replay, UUID/content conflicts,
unlinked participants, closed DMs, transient failures, uncertain receipts, and mention
suppression. Track's adjacent `npm run test:e2e:discord` covers the real cross-repo
protocol with a disposable PostgreSQL database and doubled Discord API.

For a real-provider test, do not call `/notifications/deliver` manually with production
secrets. Use Track's organizer campaign and event-reminder flows so preferences,
leases, audit events, and per-channel state are exercised. Follow every step and send
boundary in the Track notification runbook. Confirm one DM reaches the designated
account, replay protection prevents duplicates, an opt-out results in no DM, and no
message or Discord identity appears in logs.

## Incident rules

- Do not retry `uncertain` automatically.
- Do not delete or edit delivery receipts to make a retry possible.
- Do not change the shared secret, stop the bot, close real users' DMs, or disrupt
  networking to manufacture a production failure test.
- Do not log request bodies: they contain message text paired with Hacker IDs.
- Do not expose Discord message IDs, account IDs, usernames, or error bodies to Track.
- Preserve receipts and Track delivery history for investigation.
