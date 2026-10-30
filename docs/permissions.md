# Permission explanations

Use `/permissions explain` to privately check whether a selected member can view a text or announcement channel, send a message in it, or send replies in its threads. The command makes no server changes and only works for users allowed by the bot's configured authorization policy.

## Calculation

The calculation follows Discord's permission rules:

1. The server owner bypasses permission restrictions. A member with `Administrator` gets all permissions and bypasses channel overwrites.
2. Otherwise, base permissions are the union of `@everyone` and the member's assigned roles.
3. Apply the `@everyone` channel overwrite (deny, then allow), aggregate all matching role overwrites (all denies, then all allows), then apply the member-specific overwrite (deny, then allow).
4. A denial of `View Channel` also blocks channel actions and thread access. Communication timeouts block sending permissions; the server owner and administrators are exempt.
5. `Send Messages in Threads` is checked independently from `Send Messages`.

The command fetches current member roles, guild roles, and channel data for each request. It compares the raw permission bits with discord.js before showing a result; a mismatch fails closed instead of returning an unverified explanation.

## Limits

- The channel option currently accepts only text and announcement channels. Forum, media, voice, stage, category, and direct thread targets are not supported.
- The thread result checks the parent channel's `Send Messages in Threads` permission. A specific thread's membership or other thread-only restrictions are not evaluated.
- Only view, normal message sending, and thread sending are explained; other Discord permissions are out of scope.
- Categories use Discord permission syncing. The command evaluates the selected channel's actual overwrites and does not treat category permissions as runtime inheritance.

The calculation follows [Discord's permission documentation](https://docs.discord.com/developers/topics/permissions), including overwrite order, implicit permissions, timeout handling, and the separate thread-send permission.
