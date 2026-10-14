# UptimeRobot test notification — Gmail receipt

Checked 2026-10-14 using the exact Gmail search `from:(uptimerobot.com) newer_than:1d`. It returned two matching test notifications in the owner-approved receiving mailbox. The authenticated mailbox matched an owner-approved test destination (`approved_mailbox_match=true`); the mailbox address and account-holder name are intentionally omitted.

- Sender domain: `uptimerobot.com` (Gmail’s sender details showed `alert@uptimerobot.com`; mailed-by and signed-by were also `uptimerobot.com`).
- Test subjects: `TEST: Monitor is DOWN: mega-xo-livez` and `TEST: Monitor is UP: mega-xo-livez`.
- Gmail received timestamp shown for each: `Oct 14, 2026, 6:32 AM`. The visible header did not specify a timezone.
- Classification: both conversations had the Inbox label; neither was shown in Spam.
- Store Monitor had observed the green “Test notification sent” confirmation at `2026-10-14 01:03:37 UTC`. That provider confirmation is separate from Gmail’s received timestamp, whose timezone is not shown.

This confirms receipt of the two test notifications in the approved mailbox. It does not prove delivery of an actual incident and recovery pair or production-user mail. Both messages appeared unread in the search results before review; opening them may have caused Gmail to mark them read. No explicit label, delete, reply, or send action was taken. This note omits the mailbox address, account-holder name, message identifiers, and message bodies.
