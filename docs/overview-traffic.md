# Overview traffic charts

The Overview displays Mosquitto's real aggregate PUBLISH counters using the existing administrative mTLS connection. No additional service or dependency is required.

- Received: `$SYS/broker/publish/messages/received`.
- Sent: `$SYS/broker/publish/messages/sent`. Fan-out can deliver one publication to multiple subscribers, so sent and received totals need not match.
- Drop markers: increments in `$SYS/broker/publish/messages/dropped`, indicating inflight/queue limits, plus failed administrative publications (connection unavailable, timeout, MQTT error or negative acknowledgement).

The first counter value establishes a baseline. The line displays observed hourly counts as average messages per minute (hourly count divided by 60), using UTC hourly buckets, with at most 168 buckets (seven days) retained in a dedicated SQLite table. Data is shared across browsers and does not depend on the selected MQTT Manager topic filters or history limit. Admin restart preserves hourly history; broker restart resets its current totals. No historical values are invented before collection starts. Missing intervals remain gaps. Counter decreases never generate negative spikes. The Overview refreshes every 15 seconds by default; the broker normally reports `$SYS` periodically. Missing/stale telemetry is indicated explicitly. Counts cover the broker, including administrative and monitoring traffic, rather than only registered devices.

Markers do not identify a particular subscriber. A successful QoS 1/2 publish confirms the publisher-to-broker exchange, not processing by all subscriber applications. Mosquitto's aggregate counters cannot correlate individual PUBACK/PUBCOMP exchanges or prove end-to-end delivery. No success/failure is inferred from a difference between received and sent totals. Application-level acknowledgements are needed for per-device delivery assurance.

Only aggregate counts and timestamps are exposed in ordinary status responses. Topics, payloads, client identities and credentials are not included in chart data. The administrative ACL already permits reading `$SYS/#`; device ACLs are unchanged.

Source: [Mosquitto broker statistics](https://mosquitto.org/man/mosquitto-8.html).

## Credential actions

When a protected certificate action needs verification, it opens the existing step-up dialog. Canceling does not submit the action. Successful verification resumes the operation once. JSON requests retry once only after a `stepUpRequired` response; the server rejects the initial request before executing the mutation. ZIP and one-time key downloads obtain authorization before sending their requests. Keys remain subject to the existing one-time delivery rules.

## Display preferences

Settings → General controls the visible period (1, 3 or 7 days), refresh interval (5, 15, 30 or 60 seconds) failure markers, and the Y-axis unit (msg/min or msg/hour). Seven days are always retained regardless of the visible period. X-axis dates use the account time zone; Y-axis ticks follow the saved unit: msg/min divides each hourly count by 60; msg/hour shows the hourly count. Fractional ticks are shown when needed. This is an hourly average, not an instantaneous minute-level rate.

Light and dark themes have independent accent, background, card, received-chart and sent-chart colors. Colors accept #RRGGBB only. Save preferences applies them to the current account immediately and persists them in SQLite. Restore default colors resets the form; save to apply. Theme selection itself retains the existing browser preference. Custom colors may reduce contrast; defaults can be restored.
