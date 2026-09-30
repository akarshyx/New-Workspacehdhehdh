---
name: Telegram gift flow
description: Official Bot API boundaries for the collectible gift experience.
---

The collectible flow must only surface gifts returned by `getAvailableGifts` with a positive `upgrade_star_count`, then call `sendGift` with `pay_for_upgrade=true`. Ordinary gifts are not valid alternatives.

**Why:** A normal Telegram Gift is not a Unique/Collectible Gift; showing or sending one would violate the product requirement.

**How to apply:** Keep the eligible catalog limited to the live upgrade-capable results, and require a separate explicit confirmation for each spend. The three-month Premium option is separate and uses `giftPremiumSubscription` with 3 months and 1,000 Stars.