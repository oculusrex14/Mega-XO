import Foundation
import StoreKit

/// Real StoreKit 2 operations, separate from network/actor authorization.
/// The signed transaction JWS is only *evidence* for the backend; never mint
/// Crowns, grant Remove Ads, or finish a transaction before durable delivery.
@MainActor
final class MegaStoreKit {
    enum StoreError: Error {
        case unconfigured
        case invalidProduct
        case wrongAccount
        case unverified
        case pending
        case cancelled
        case unavailable
        case notDelivered
    }

    /// Store identifiers must be configured from the approved App Store
    /// Connect catalogue. An absent mapping keeps native commerce disabled.
    private let ids: [String: String]
    private var active: [String: Product] = [:]
    private let keys = ["crowns_100", "crowns_525", "crowns_1100", "remove_ads"]

    init(configuration: [String: String]) {
        // A complete one-to-one mapping is mandatory. No default guessed IDs.
        let names = keys.compactMap { configuration[$0]?.trimmingCharacters(in: .whitespacesAndNewlines) }
        if names.count == keys.count && names.allSatisfy({ !$0.isEmpty })
            && Set(names).count == keys.count {
            ids = configuration
        } else {
            ids = [:]
        }
    }

    static func fromBundle() -> MegaStoreKit {
        MegaStoreKit(configuration: Bundle.main.object(forInfoDictionaryKey: "MegaStoreProductIDs")
                     as? [String: String] ?? [:])
    }

    func products() async throws -> [[String: String]] {
        guard ids.count == keys.count else { throw StoreError.unconfigured }
        let found = try await Product.products(for: Array(ids.values))
        active = Dictionary(uniqueKeysWithValues: found.map { ($0.id, $0) })
        return keys.compactMap { key in
            guard let storeId = ids[key], let product = active[storeId] else { return nil }
            return ["id": key, "price": product.displayPrice]
        }
    }

    func purchase(_ id: String, accountToken: String) async throws -> [String: String] {
        guard ids.count == keys.count, let storeId = ids[id] else {
            throw StoreError.unconfigured
        }
        guard let token = UUID(uuidString: accountToken), token.uuidString.lowercased() == accountToken.lowercased()
        else { throw StoreError.wrongAccount }
        if active[storeId] == nil { _ = try await products() }
        guard let product = active[storeId] else { throw StoreError.invalidProduct }
        let result = try await product.purchase(options: [.appAccountToken(token)])
        switch result {
        case .success(let verified):
            guard case let .verified(transaction) = verified else { throw StoreError.unverified }
            guard transaction.productID == storeId, transaction.appAccountToken == token,
                  transaction.revocationDate == nil else { throw StoreError.wrongAccount }
            return ["store": "apple", "signedTransactionInfo": verified.jwsRepresentation]
        case .pending:
            throw StoreError.pending
        case .userCancelled:
            throw StoreError.cancelled
        @unknown default:
            throw StoreError.unavailable
        }
    }

    func restore(accountToken: String) async throws -> [[String: String]] {
        guard let token = UUID(uuidString: accountToken) else { throw StoreError.wrongAccount }
        guard ids.count == keys.count, let removeAds = ids["remove_ads"]
        else { throw StoreError.unconfigured }
        // User-initiated restore only. Never restore consumable Crown packs.
        try await AppStore.sync()
        var receipts: [[String: String]] = []
        for await signed in Transaction.currentEntitlements {
            guard case let .verified(transaction) = signed else { continue }
            guard transaction.productID == removeAds && transaction.revocationDate == nil,
                  transaction.appAccountToken == token else { continue }
            receipts.append(["store": "apple", "signedTransactionInfo": signed.jwsRepresentation])
        }
        return receipts
    }

    func unfinishedEvidence() async -> [[String: String]] {
        guard ids.count == keys.count else { return [] }
        let allowed = Set(ids.values)
        var evidence: [[String: String]] = []
        for await signed in Transaction.unfinished {
            guard case let .verified(transaction) = signed,
                  allowed.contains(transaction.productID), transaction.revocationDate == nil else { continue }
            evidence.append(["store": "apple", "signedTransactionInfo": signed.jwsRepresentation])
        }
        return evidence
    }

    func finish(evidence: [String: String], serverDeliveryConfirmed: Bool) async throws {
        guard serverDeliveryConfirmed else { throw StoreError.notDelivered }
        guard evidence["store"] == "apple",
              let jws = evidence["signedTransactionInfo"], !jws.isEmpty
        else { throw StoreError.unverified }
        // Never treat arbitrary client-supplied "delivered": true as proof:
        // this method is called only after the native authenticated API
        // layer has confirmed a committed backend outcome for this exact JWS.
        for await signed in Transaction.unfinished {
            guard case let .verified(transaction) = signed else { continue }
            if signed.jwsRepresentation == jws {
                await transaction.finish()
                return
            }
        }
        // The backend already committed delivery for this *exact* evidence.
        // Finishing a consumed/previously finished transaction is idempotent:
        // there is no remaining unfinished entry to act on. Returning here
        // never grants local currency, ownership or account identity.
        return
    }
}
