# Native identity integration (V3.3.3)

The repository is still a browser/Node project. The Kotlin and Swift files are adapters to add to a real Android/iOS application, not built APK/IPA targets. They were not compiled or tested on physical devices in this run. Web OAuth is implemented separately and works when configured.

## Client/server contract

Expose the following promise-based bridge only to the application's fixed, trusted origin, never arbitrary WebView content:

```js
window.MegaNativeIdentity = {
  // Call the platform helper. Return an ID token, not a user ID or email.
  getCredential: async ({provider, nonce}) => ({idToken: /* SDK result */})
};
```

The browser controller first requests `POST /api/account/native/challenge` with `{provider, intent: 'login'|'link'}`. The server returns state and nonce, bound to the current HttpOnly session. Pass that exact nonce to the SDK. Then the controller sends the SDK ID token and state to `/api/account/native/finish`. The server verifies the signature and all claims before creating/restoring/linking a profile. Native credentials are not stored in localStorage. Keep the HTTP cookie session and CSRF context on the same origin.

## Android / Google

Use Credential Manager and the Google ID library. Add the helper's required `androidx.credentials`, `credentials-play-services-auth`, and `com.google.android.libraries.identity.googleid:googleid` dependencies at compatible versions for the app's Gradle/minSdk configuration. Resolve versions from official release notes rather than copying an old SDK version.

Configure the Android package/signing certificate in Google Cloud and configure a Web/server client ID. The helper's `serverClientId` must match `GOOGLE_NATIVE_AUDIENCES`. If the issued token has an `azp` Android client identifier, allow that exact identifier via `GOOGLE_AUTHORIZED_PARTIES`. Do not enable broad/wildcard audiences.

Google account login is distinct from Play Billing and Play Games Services. This implementation does not pretend a Play purchase is identity proof, nor does it add Play Games achievements or cloud-save APIs. The cloud profile lives in the game's server. A user without a Google account can create one through Google's own system flow, not by giving this app a Google password.

## Apple / iOS

Enable Sign in with Apple capability on the real App ID. Set the bundle ID in `APPLE_NATIVE_AUDIENCES`. Group the web Services ID under the correct primary native App ID so Apple identity subjects remain consistent across intended app/web surfaces. Pass the current scene's presentation window to the helper; retain the helper through completion. Do not hash the nonce a second time unless the server contract is changed to expect that exact value.

Web Apple sign-in requires a real registered HTTPS callback domain; localhost is not a valid production Apple return URL. The code-only, no-personal-scopes flow permits a query callback. Google/Apple subjects, not email addresses, are identity keys. Hide My Email does not create a new Mega XO account when the Apple subject stays the same.

## Release checks still required

Real provider consent/cancellation, deep links/universal links, WebView origin restrictions, Keychain/Keystore or cookie-store lifecycle, Android Credential Manager UI, Swift concurrency/compiler compatibility, revoked-credential handling, Apple server notifications, account-deletion/revocation policy, backup/restore on real devices and native provider button branding. Provider-link changes must not be treated as account deletion. Do not ship a fake success bridge or the test fixture server.

## Official references (checked 5 October 2026)

- https://developer.android.com/identity/sign-in/credential-manager-siwg-implementation
- https://developers.google.com/identity/android-credential-manager/releases
- https://developers.google.com/identity/openid-connect/openid-connect
- https://developer.apple.com/documentation/authenticationservices/implementing-user-authentication-with-sign-in-with-apple
- https://developer.apple.com/documentation/signinwithapple/incorporating-sign-in-with-apple-into-other-platforms
