# Sensitive information rendering

Use `frontend/components/SensitiveValue.vue` for sensitive values and objects. Do not implement hiding with CSS, blur filters, tooltips, hidden inputs, or attributes containing the original value.

```vue
<SensitiveValue scope="infrastructure" :value="details?.hostname" label="Hostname" />

<SensitiveValue scope="devices" label="Certificate details">
  <CertificateDetails :certificate="certificate" />
</SensitiveValue>
```

The component renders `••••••` by default using the shared `sensitive-value` and `sensitive-value__mask` classes. Its content slot is mounted only while the matching server authorization is active. An optional `show-eye` property provides a local eye button; the header eye remains the primary control for lists.

Scopes are `infrastructure`, `devices`, `mqtt`, and `audit`. Obtain protected values using `sensitiveFetch(scope, endpoint)` after authorization. Clear fetched records and close streams when the scope expires or is hidden. A masked component alone is not an API access control.

`DataList.vue` always renders real rows. Names, device identifiers, labels, provisioning methods, algorithms, certificate Subject, status, authorization, issuance dates, and expiration dates are ordinary administrative metadata and remain visible. Default list API responses omit certificate serials, fingerprints, SAN, public key metadata, and certificate bodies. Use `SensitiveValue` only for those protected cells and details. Dashboard connection details and runtime logs use the same renderer.

Visibility and verification timeout settings are under **Settings → General**. The default reveal timeout is 60 seconds. Any non-negative whole number of seconds is accepted; `0` disables the reveal timer. The **Hide when the browser window loses focus** setting is enabled by default and also hides values when the page moves to the background. It can be disabled; manual hiding, session expiry, and full page leave/reload still clear revealed values. In-app Gateway navigation preserves revealed scope state until one of those conditions occurs. Reveal grants remain bound to the current user and session, stored in memory on the server, and represented by an HttpOnly cookie; they cannot outlive the administrative session. Changing the policy revokes existing grants and requires authentication. Disabling additional verification still requires an authenticated administrative session and an explicit reveal action, with server-side authorization scoped to that session.

Never use this component to expose CA private keys, password hashes, stored TOTP secrets, or previously delivered device private keys. Those values remain inaccessible.

Pending broker changes show device names, action names, actor and timestamps normally. Only certificate serials and free-form event details are redacted. MQTT configuration and publishing are authenticated administrative operations; hiding message contents does not require revealing them to use these controls. Raw logs remain protected because they can contain client addresses and certificate identifiers.

Live Messages keeps received timestamps, QoS, retain flags and byte counts available without reveal authorization. Only topic and payload are masked. Both history and SSE responses omit topic/text/base64 while hidden, and SSE authorization is checked for every event. Hiding does not stop metadata updates.
