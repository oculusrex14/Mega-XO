import Foundation

/// P05/P20-03 iOS session lifecycle, the parity counterpart of Android's MegaNativeSessionManager.
///
/// The access token lives in this actor's memory; the refresh credential lives in
/// MegaNativeSecretVault (Keychain, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, this-device-only,
/// non-synchronizing). JavaScript never receives, supplies or stores either value.
///
/// Wire contract (frozen by the repository's own validators, identical to Android):
///   - request bodies <- packages/contracts/access-dto.js:validateNativeTokenGrant. Its provider
///     branch delegates to native-bridge.js:validateFinishRequest, so the provider grant body on
///     /native/token IS the finish request {provider,state,idToken}. There is no separate finish
///     round trip on the bearer path.
///   - Authorization: Bearer <access>, no cookie, no Origin, no CSRF header on token/refresh/logout.
///   - refreshToken is base64url and at most 512 characters (MAX_REFRESH_TOKEN_LENGTH).
///
/// Failure policy mirrors Android exactly: strict response validation, an unparseable answer leaves
/// the held session untouched, an ABSENT refreshToken means "keep the stored one", and HTTP 401
/// from /native/refresh is terminal revocation (wipe Keychain, drop the token, signed-out state).
actor MegaNativeSession {
    enum Outcome: String {
        case ok = "OK"
        case invalid = "INVALID"
        case unavailable = "UNAVAILABLE"
        case revoked = "REVOKED"
    }

    struct Held {
        let accessToken: String
        let refreshToken: String?
        let expiresAt: Date
        let actorId: String?
    }

    private let vault: MegaNativeSecretVault
    private let http: MegaNativeHTTP
    private var held: Held?
    private var refreshing = false
    private var pendingRefresh: [CheckedContinuation<Outcome, Never>] = []
    /// Set once a refresh returned 401; online use is refused until a fresh sign-in succeeds.
    private var revoked = false

    /// design B2.1 access TTL, used ONLY when the server omits expiresIn.
    static let defaultAccessTTL: TimeInterval = 300
    /// packages/contracts/access-dto.js MAX_REFRESH_TOKEN_LENGTH.
    static let maxRefreshTokenLength = 512

    init(vault: MegaNativeSecretVault, http: MegaNativeHTTP) {
        self.vault = vault
        self.http = http
    }

    func currentAccessToken() -> String? { held?.accessToken }

    func status() -> (linked: Bool, expiresAt: Date?, actorId: String?) {
        (held != nil, held?.expiresAt, held?.actorId)
    }

    func clearLocal() async {
        held = nil
        await http.revokeLocalAccess()
    }

    /// Server-issued challenge for a first sign-in: the only native route legitimately called with
    /// no access token. No state or nonce is ever generated locally.
    func challenge(provider: String, intent: String) async -> Result<(state: String, nonce: String, sessionToken: String), Error> {
        guard ["google", "apple"].contains(provider),
              ["login", "link", "reauth"].contains(intent) else {
            return .failure(RequestError.invalidBody)
        }
        let body = try? JSONSerialization.data(withJSONObject: ["provider": provider, "intent": intent])
        guard let body else { return .failure(RequestError.invalidBody) }
        do {
            let (status, data) = try await http.authRequest(
                path: "/api/account/native/challenge", bearer: nil, body: body)
            guard (200...299).contains(status),
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let state = object["state"] as? String,
                  let nonce = object["nonce"] as? String,
                  Self.isBase64URL(state), state.utf8.count <= 512,
                  Self.isBase64URL(nonce), nonce.utf8.count <= 512
            else { return .failure(RequestError.responseInvalid) }
            // A first-ever sign-in bootstraps the session the attempt hangs off; the server
            // returns its bearer in the body and the follow-up token leg must present it.
            let sessionToken = object["sessionToken"] as? String ?? ""
            return .success((state, nonce, sessionToken))
        } catch {
            return .failure(error)
        }
    }

    /// Provider grant. Every value is server-issued; nothing here mints a credential.
    func signIn(provider: String, state: String, idToken: String, sessionToken: String = "") async -> Outcome {
        guard ["google", "apple"].contains(provider),
              Self.isBase64URL(state), state.utf8.count <= 512,
              idToken.utf8.count <= 16384
        else { return .invalid }
        var payload: [String: Any] = ["provider": provider, "state": state, "idToken": idToken]
        if !sessionToken.isEmpty { payload["sessionToken"] = sessionToken }
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return .invalid }
        return await exchange(path: "/api/account/native/token", body: body, rotating: false)
    }

    /// Single-flight refresh: concurrent callers share one rotation, so a family is never rotated
    /// twice for one expiry (design B3.2).
    func refresh() async -> Outcome {
        if revoked { return .revoked }
        if refreshing {
            return await withCheckedContinuation { continuation in
                pendingRefresh.append(continuation)
            }
        }
        let stored = held?.refreshToken ?? (try? vault.loadRefreshCredential()) ?? nil
        guard let stored else { return .invalid }
        refreshing = true
        guard let body = try? JSONSerialization.data(withJSONObject: [
            "grant": "refresh_token", "refreshToken": stored
        ]) else {
            finishRefreshing(.invalid)
            return .invalid
        }
        // The refresh grant itself is the credential; an expired access token is not presented,
        // and the server refuses a cookie+bearer pair anyway.
        let outcome = await exchange(path: "/api/account/native/refresh", body: body, rotating: true)
        finishRefreshing(outcome)
        return outcome
    }

    private func finishRefreshing(_ outcome: Outcome) {
        refreshing = false
        let waiters = pendingRefresh
        pendingRefresh.removeAll()
        waiters.forEach { $0.resume(returning: outcome) }
    }

    /// Best-effort family revocation: a 2xx is treated as revoked, and local credentials are
    /// cleared either way so the user is never left believing a dead session is still live.
    func signOut(allDevices: Bool) async -> Bool {
        let token = currentAccessToken()
        let body = (try? JSONSerialization.data(withJSONObject: allDevices ? ["allDevices": true] : [:])) ?? Data("{}".utf8)
        var revokedRemotely = token == nil
        if let token {
            let (status, _) = (try? await http.authRequest(
                path: "/api/account/native/logout", bearer: token, body: body)) ?? (0, Data())
            revokedRemotely = (200...299).contains(status)
        }
        held = nil
        revoked = false
        await http.revokeLocalAccess()
        try? vault.clear()
        return revokedRemotely
    }

    /// Validates the frozen response shape and installs it. Any deviation leaves the held session
    /// exactly as it was: a half-parsed credential is never stored.
    private func exchange(path: String, body: Data, rotating: Bool) async -> Outcome {
        let response: (Int, Data)
        do {
            response = try await http.authRequest(path: path, bearer: nil, body: body)
        } catch {
            return .unavailable
        }
        let (status, data) = response
        if status == 401 && rotating {
            await revokeEverything()
            return .revoked
        }
        guard (200...299).contains(status) else { return .unavailable }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let access = object["accessToken"] as? String,
              Self.isCompactJWS(access)
        else { return .invalid }
        let issued = (object["refreshToken"] as? String) ?? ""
        if !issued.isEmpty,
           issued.utf8.count > Self.maxRefreshTokenLength || !Self.isBase64URL(issued) {
            return .invalid
        }
        let ttl: TimeInterval
        if let seconds = object["expiresIn"] as? Int {
            guard (30...86400).contains(seconds) else { return .invalid }
            ttl = TimeInterval(seconds)
        } else {
            ttl = Self.defaultAccessTTL
        }
        let actorId = (object["actorId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        // Persist the refresh credential before it can be needed; a vault write that fails refuses
        // the exchange rather than losing a rotation on the next launch.
        let refresh = issued.isEmpty ? (held?.refreshToken ?? (try? vault.loadRefreshCredential()) ?? nil) : issued
        if let refresh {
            do { try vault.saveRefreshCredential(refresh) } catch { return .unavailable }
        }
        held = Held(accessToken: access, refreshToken: refresh,
                    expiresAt: Date().addingTimeInterval(ttl), actorId: actorId)
        revoked = false
        await http.installVerifiedAccessToken(access)
        return .ok
    }

    private func revokeEverything() async {
        held = nil
        revoked = true
        await http.revokeLocalAccess()
        try? vault.clear()
    }

    private static func isCompactJWS(_ value: String) -> Bool {
        guard value.utf8.count >= 24, value.utf8.count <= 8192 else { return false }
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 3 && parts.allSatisfy { isBase64URL(String($0)) }
    }

    private static func isBase64URL(_ value: String) -> Bool {
        !value.isEmpty && value.allSatisfy { character in
            character.isASCII && (character.isLetter || character.isNumber || character == "-" || character == "_")
        }
    }

    enum RequestError: Error { case invalidBody, invalidPath, responseInvalid }
}
