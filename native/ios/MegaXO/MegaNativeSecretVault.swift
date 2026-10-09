import Foundation
import Security

/// P20-03 non-synchronizing, device-bound refresh credential storage.
/// The JS bundle receives neither this Keychain item nor arbitrary network access.
struct MegaNativeSecretVault {
    enum Failure: Error {
        case keychain(OSStatus)
        case invalidEncoding
    }

    private let account = "refresh"
    private var service: String {
        (Bundle.main.bundleIdentifier ?? "online.megaxo.prototype") + ".native-auth-v1"
    }
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: kCFBooleanFalse as Any]
    }

    func saveRefreshCredential(_ credential: String) throws {
        guard !credential.isEmpty, credential.utf8.count <= 8192 else { throw Failure.invalidEncoding }
        let data = Data(credential.utf8)
        let updateStatus = SecItemUpdate(query as CFDictionary,
                                         [kSecValueData as String: data] as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else { throw Failure.keychain(updateStatus) }

        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw Failure.keychain(status) }
    }

    func loadRefreshCredential() throws -> String? {
        var find = query
        find[kSecReturnData as String] = kCFBooleanTrue
        find[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(find as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Failure.keychain(status) }
        guard let data = result as? Data, let credential = String(data: data, encoding: .utf8)
        else { throw Failure.invalidEncoding }
        return credential
    }

    func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw Failure.keychain(status)
        }
    }

    /// On iOS Keychain can outlive uninstall. Do not silently restore an old
    /// session after a fresh reinstall whose sandbox/user defaults are new.
    func clearForFreshInstallIfRequired() throws {
        let marker = "mega.native.install.initialized.v1"
        guard !UserDefaults.standard.bool(forKey: marker) else { return }
        try clear()
        UserDefaults.standard.set(true, forKey: marker)
    }
}
