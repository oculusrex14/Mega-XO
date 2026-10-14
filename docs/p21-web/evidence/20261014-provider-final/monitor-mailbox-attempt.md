# UptimeRobot test notification — mailbox observation receipt

Observed 2026-10-14. This receipt contains no mailbox address, account name, message ID, message body, or private identifier.

- Store-monitor reported the approved test destination matched one of the owner-approved mailboxes. `recipient_is_approved=true`.
- Store-monitor observed the provider's green “Test notification sent” confirmation at `2026-10-14 01:03:37 UTC`. This is a UI confirmation-observed time, not a provider delivery event or mailbox receive timestamp.
- The existing browser Gmail session was the approved business mailbox, which did not match the test recipient (`open_inbox_matches_recipient=false`). The only other approved mailbox had no existing signed-in session in the available browser profile. The Gmail connector required reauthentication.
- Exact Gmail search used in the open session: `from:(uptimerobot.com) newer_than:1d`. It returned no matching messages in that business mailbox. This does not establish delivery or non-delivery to the actual test recipient.
- No matching message was opened. Sender-domain, exact subject, received timestamp, and INBOX/SPAM classification are **NOT_OBSERVED**.

No mail was sent, deleted, labeled, marked read, or otherwise changed by this check. No unrelated messages were inspected. The Gmail tab is left available for owner handoff to the already-approved recipient mailbox; no account was added and no credentials or MFA codes were entered.
