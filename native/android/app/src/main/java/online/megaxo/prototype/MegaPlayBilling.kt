package online.megaxo.prototype

import android.app.Activity
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams

/**
 * Real Google Play Billing 9, with exactly four backend catalogue IDs.
 *
 * No client-side asset mutation. A purchaseToken is forwarded for server
 * verification; consume/acknowledge is a backend-owned post-commit operation.
 * This provider is unconfigured/disabled until real Play Console product IDs,
 * authenticated actor binding and signed app identity are established.
 */
internal class MegaPlayBilling(
    private val activity: Activity,
    productMapping: Map<String, String>,
    private val onUnsolicitedEvidence: (Map<String, String>) -> Unit = {}
) : PurchasesUpdatedListener {
    private val catalogue = listOf("crowns_100", "crowns_525", "crowns_1100", "remove_ads")
    private val mapping: Map<String, String> =
        if (catalogue.all { !productMapping[it].isNullOrBlank() } &&
            productMapping.values.toSet().size == catalogue.size && productMapping.size == catalogue.size
        ) productMapping.toMap() else emptyMap()
    private val details = mutableMapOf<String, ProductDetails>()
    private var pending: Pair<String, (Result<Map<String, String>>) -> Unit>? = null
    private var activeAccount: String? = null
    private val client: BillingClient = BillingClient.newBuilder(activity)
        .setListener(this)
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .enableAutoServiceReconnection()
        .build()

    fun connect(onDone: (Boolean) -> Unit) {
        if (mapping.size != catalogue.size) { onDone(false); return }
        if (client.isReady) { onDone(true); return }
        client.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) {
                onDone(result.responseCode == BillingClient.BillingResponseCode.OK)
            }
            override fun onBillingServiceDisconnected() {
                // No automatic purchase resolution or local grant on disconnect.
            }
        })
    }

    fun products(complete: (Result<List<Map<String, String>>>) -> Unit) {
        if (!client.isReady || mapping.size != catalogue.size) {
            complete(Result.failure(IllegalStateException("STORE_UNAVAILABLE"))); return
        }
        val requested = catalogue.map { key ->
            QueryProductDetailsParams.Product.newBuilder()
                .setProductId(mapping.getValue(key))
                .setProductType(BillingClient.ProductType.INAPP)
                .build()
        }
        val query = QueryProductDetailsParams.newBuilder().setProductList(requested).build()
        client.queryProductDetailsAsync(query) { result, found ->
            if (result.responseCode != BillingClient.BillingResponseCode.OK) {
                complete(Result.failure(IllegalStateException("STORE_UNAVAILABLE"))); return@queryProductDetailsAsync
            }
            details.clear()
            for (product in found.productDetailsList) details[product.productId] = product
            val localized = catalogue.mapNotNull { key ->
                val product = details[mapping[key]] ?: return@mapNotNull null
                val offer = product.oneTimePurchaseOfferDetailsList?.firstOrNull() ?: return@mapNotNull null
                mapOf("id" to key, "price" to offer.formattedPrice)
            }
            complete(Result.success(localized))
        }
    }

    fun purchase(id: String, obfuscatedAccountId: String, complete: (Result<Map<String, String>>) -> Unit) {
        if (mapping.size != catalogue.size || !mapping.containsKey(id) ||
            obfuscatedAccountId.isBlank() || obfuscatedAccountId.length > 64 ||
            !client.isReady || pending != null) {
            complete(Result.failure(IllegalStateException("STORE_UNAVAILABLE"))); return
        }
        val product = details[mapping[id]]
        if (product == null) { complete(Result.failure(IllegalStateException("STORE_UNAVAILABLE"))); return }
        val offer = product.oneTimePurchaseOfferDetailsList?.firstOrNull()
        if (offer == null) { complete(Result.failure(IllegalStateException("STORE_UNAVAILABLE"))); return }
        activeAccount = obfuscatedAccountId
        pending = id to complete
        val item = BillingFlowParams.ProductDetailsParams.newBuilder()
            .setProductDetails(product)
            .setOfferToken(offer.offerToken)
            .build()
        val params = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(item))
            .setObfuscatedAccountId(obfuscatedAccountId)
            .build()
        val result = client.launchBillingFlow(activity, params)
        if (result.responseCode != BillingClient.BillingResponseCode.OK) {
            pending = null
            complete(Result.failure(IllegalStateException("STORE_UNAVAILABLE")))
        }
    }

    override fun onPurchasesUpdated(result: BillingResult, purchases: MutableList<Purchase>?) {
        val old = pending
        if (result.responseCode == BillingClient.BillingResponseCode.USER_CANCELED) {
            pending = null
            old?.second?.invoke(Result.failure(IllegalStateException("STORE_CANCELLED")))
            return
        }
        if (result.responseCode != BillingClient.BillingResponseCode.OK || purchases.isNullOrEmpty()) {
            pending = null
            old?.second?.invoke(Result.failure(IllegalStateException("STORE_UNAVAILABLE")))
            return
        }
        for (purchase in purchases) {
            // Pending/unverified state is NOT a grant or consumable finish.
            if (purchase.purchaseState != Purchase.PurchaseState.PURCHASED) continue
            if (activeAccount != null &&
                purchase.accountIdentifiers?.obfuscatedAccountId != activeAccount) continue
            val id = old?.first
            val matched = id != null && mapping[id] in purchase.products
            val evidence = mapOf("store" to "google", "purchaseToken" to purchase.purchaseToken)
            if (matched) {
                pending = null
                old.second.invoke(Result.success(evidence))
            } else if (id == null && purchase.products.any { it in mapping.values }) {
                // Future native P05 transport will enqueue these for backend
                // verification. The host never consumes or mints here.
                onUnsolicitedEvidence(evidence)
            }
        }
    }

    fun restore(obfuscatedAccountId: String, done: (Result<List<Map<String, String>>>) -> Unit) {
        if (!client.isReady || mapping.size != catalogue.size || obfuscatedAccountId.isBlank()) {
            done(Result.failure(IllegalStateException("STORE_UNAVAILABLE"))); return
        }
        val query = QueryPurchasesParams.newBuilder()
            .setProductType(BillingClient.ProductType.INAPP).build()
        client.queryPurchasesAsync(query) { result, purchases ->
            if (result.responseCode != BillingClient.BillingResponseCode.OK) {
                done(Result.failure(IllegalStateException("STORE_UNAVAILABLE"))); return@queryPurchasesAsync
            }
            // Consumable Crowns are NEVER restored as a new grant.
            val restored = purchases.filter {
                it.purchaseState == Purchase.PurchaseState.PURCHASED &&
                it.products.contains(mapping["remove_ads"]) &&
                it.accountIdentifiers?.obfuscatedAccountId == obfuscatedAccountId
            }.map { mapOf("store" to "google", "purchaseToken" to it.purchaseToken) }
            done(Result.success(restored))
        }
    }

    fun finishAfterBackendDelivery(evidence: Map<String, String>, backendCommitted: Boolean) {
        check(backendCommitted && evidence["store"] == "google" && !evidence["purchaseToken"].isNullOrBlank())
        // Deliberate no-op: provider verification and Play consume/ack are
        // server-to-server after the exact authoritative wallet commit.
    }

    fun close() {
        pending = null
        activeAccount = null
        client.endConnection()
    }
}
