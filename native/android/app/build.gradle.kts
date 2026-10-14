import org.gradle.api.tasks.Exec
import org.gradle.api.tasks.Sync
import java.io.File
import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val repoRoot = rootProject.projectDir.resolve("../..").canonicalFile
val generatedAssets = layout.buildDirectory.dir("generated/megaAssets")
val googleNativeServerClientId = providers.gradleProperty("megaGoogleServerClientId").orNull ?: ""
val nativeAppId = providers.gradleProperty("megaApplicationId").get()
val nativeVersionCode = providers.gradleProperty("megaVersionCode").orNull?.toIntOrNull() ?: 1
val nativeVersionName = providers.gradleProperty("megaVersionName").orNull ?: "0.1.0-native-dev"
// Never commit keys or configure release signing from debug keystores.
val releaseStorePath = System.getenv("MEGA_ANDROID_RELEASE_KEYSTORE_PATH")
val releaseStorePassword = System.getenv("MEGA_ANDROID_RELEASE_STORE_PASSWORD")
val releaseKeyAlias = System.getenv("MEGA_ANDROID_RELEASE_KEY_ALIAS")
val releaseKeyPassword = System.getenv("MEGA_ANDROID_RELEASE_KEY_PASSWORD")
val releaseSigningConfigured = listOf(
    releaseStorePath, releaseStorePassword, releaseKeyAlias, releaseKeyPassword
).all { !it.isNullOrBlank() }

require(googleNativeServerClientId.isEmpty() ||
    Regex("^[a-zA-Z0-9_-]+\\.apps\\.googleusercontent\\.com$").matches(googleNativeServerClientId)) {
    "The native Google server audience must be an exact registered Google OAuth Web client ID"
}

// P20-03 authenticated API origin for the native session manager. Empty by default: a build that
// does not name an approved origin has no host baked in and the native transport stays
// unconfigured. Only an absolute, credential-free, path-free, query-free HTTPS origin is accepted,
// so a debug build cannot be pointed at a plaintext or attacker-chosen endpoint by accident.
val apiOrigin = (providers.gradleProperty("megaApiOrigin").orNull ?: "").trim()
require(apiOrigin.isEmpty() || Regex("^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?$").matches(apiOrigin)) {
    "megaApiOrigin must be an absolute HTTPS origin with no path, credentials or query"
}

// The shared P01 bundler correctly REFUSES all writes under native/. Stage
// outside the checkout, then let Gradle Sync own the disposable build/ copy.
val workspaceKey = MessageDigest.getInstance("SHA-256")
    .digest(repoRoot.absolutePath.toByteArray(Charsets.UTF_8))
    .take(12).joinToString("") { "%02x".format(it) }
val externalBundle = File(gradle.gradleUserHomeDir, "mega-xo/v5-android-bundles/$workspaceKey/mega")
val stageMegaClient = tasks.register<Exec>("stageMegaClient") {
    description = "Generate the allowlisted client outside the protected checkout"
    group = "build"
    inputs.file(repoRoot.resolve("native/client/bundle.config.json"))
    inputs.file(repoRoot.resolve("index.html"))
    inputs.files(fileTree(repoRoot.resolve("src")), fileTree(repoRoot.resolve("public")), fileTree(repoRoot.resolve("assets/vendor")))
    outputs.dir(externalBundle)
    commandLine(
        "node",
        repoRoot.resolve("scripts/v5/build-client.js").absolutePath,
        "--root", repoRoot.absolutePath,
        "--output", externalBundle.absolutePath
    )
}
// Compile the existing reviewed V4 native Google provider helper verbatim.
// It is NOT exposed as a browser bridge until P05 owns nonce/session exchange.
val identitySources = layout.buildDirectory.dir("generated/identitySources")
val stageGoogleIdentitySource = tasks.register<Sync>("stageGoogleIdentitySource") {
    from(rootProject.projectDir.resolve("MegaGoogleIdentity.kt"))
    into(identitySources.get().asFile.resolve("com/megaxo/identity"))
}
val generateMegaClient = tasks.register<Sync>("generateMegaClient") {
    description = "Copy the generated client into disposable Android build assets"
    group = "build"
    dependsOn(stageMegaClient)
    from(externalBundle)
    into(generatedAssets.get().asFile.resolve("mega"))
}

// P20-06 ad identifiers for the NATIVE ads bridge only. The owner's values are empty by default,
// exactly like the API origin: a RELEASE build that does not explicitly name approved units publishes
// no `window.MegaAds` and requests nothing. A DEBUG build falls back to Google's own demo units (never
// live inventory) so the bridge is exercisable on an emulator. These are public provider identifiers,
// not credentials, and live serving is still decided by the backend's MEGA_AD_MODE (which stays `off`
// until consent, SSV and store review are accepted).
// The AdMob application id. Public provider identifier, not a credential: the official Google test
// app id is the default so a non-distributing prototype never requests live inventory. A real
// release requires an owner-verified registration.
val adMobAppId = providers.gradleProperty("megaAdMobAppId").orNull
    ?: "ca-app-pub-3940256099942544~3347511713"
require(Regex("^ca-app-pub-[0-9]{16}~[0-9]{10}$").matches(adMobAppId)) {
    "megaAdMobAppId must be an exact AdMob application id"
}
val adMobRewardedUnit = (providers.gradleProperty("megaAdMobRewardedUnit").orNull ?: "").trim()
val adMobInterstitialUnit = (providers.gradleProperty("megaAdMobInterstitialUnit").orNull ?: "").trim()
// A device/emulator pass supplies the official Google demo units, which carry no revenue and no
// invalid-traffic risk:
//   -PmegaAdMobRewardedUnit=ca-app-pub-3940256099942544/5224354917 \
//   -PmegaAdMobInterstitialUnit=ca-app-pub-3940256099942544/1033173712
// No live unit id is committed here, and an empty value simply publishes no window.MegaAds.
require(adMobRewardedUnit.isEmpty() ||
    Regex("^ca-app-pub-[0-9]{16}/[0-9]{10}$").matches(adMobRewardedUnit)) {
    "megaAdMobRewardedUnit must be an exact AdMob ad unit id"
}
require(adMobInterstitialUnit.isEmpty() ||
    Regex("^ca-app-pub-[0-9]{16}/[0-9]{10}$").matches(adMobInterstitialUnit)) {
    "megaAdMobInterstitialUnit must be an exact AdMob ad unit id"
}
// A DEBUG build defaults to Google's own demo units - the documented test units, never live
// inventory - so `window.MegaAds` is actually exercisable on an emulator or device, exactly like the
// test AdMob app id above. An explicit -P value wins, and a RELEASE build names only what the owner
// supplied, so no unreviewed unit is ever built into a distributable artifact.
val debugAdMobRewardedUnit = adMobRewardedUnit.ifEmpty { "ca-app-pub-3940256099942544/5224354917" }
val debugAdMobInterstitialUnit =
    adMobInterstitialUnit.ifEmpty { "ca-app-pub-3940256099942544/1033173712" }

android {
    namespace = "online.megaxo.prototype"
    compileSdk = 35

    defaultConfig {
        applicationId = nativeAppId
        minSdk = 28
        targetSdk = 35
        versionCode = nativeVersionCode
        versionName = nativeVersionName
        buildConfigField("String", "MEGA_GOOGLE_SERVER_CLIENT_ID", "\"$googleNativeServerClientId\"")
        // The AdMob application id the native ads bridge initialises with. Public identifier; the
        // manifest's `com.google.android.gms.ads.APPLICATION_ID` carries the same value.
        buildConfigField("String", "MEGA_ADMOB_APP_ID", "\"$adMobAppId\"")
        // P20-03: the authenticated API origin for the NATIVE session manager only. Empty by
        // default, so an offline build (and any build that does not explicitly name an approved
        // origin) bakes in no host at all and MegaNativeHttpClient stays unconfigured. The WebView's
        // /api/* interception stays hard-blocked in BOTH flavors: the native shell, never JS, owns
        // the bearer. Must be an absolute https origin with no path/credentials/query.
        manifestPlaceholders["megaApiOrigin"] = apiOrigin
        buildConfigField("String", "MEGA_API_ORIGIN", "\"$apiOrigin\"")
        // P20-03 ONLINE TARGET SWITCH. The `offline` flavor (the DEFAULT, and the only artifact the
        // release path builds without an explicit choice) keeps `tools:node="remove"` on
        // INTERNET/ACCESS_NETWORK_STATE, so an accidentally built APK cannot reach the network.
        // The `online` flavor drops those removals for the authenticated online target, whose
        // transport, Keystore session vault and provider identity bridge are already implemented
        // (MegaNativeHttpClient/MegaSecureSessionVault/MegaAndroidIdentityBridge). AD_ID stays
        // removed in BOTH flavors. Build the online variant with `:app:assembleOnlineDebug`.
        flavorDimensions += "target"
        productFlavors {
            create("offline") {
                dimension = "target"
                buildConfigField("boolean", "MEGA_ONLINE_TARGET", "false")
            }
            create("online") {
                dimension = "target"
                buildConfigField("boolean", "MEGA_ONLINE_TARGET", "true")
            }
        }
        // Official test app ID for a non-distributing, offline prototype.
        // Real releases require an owner-verified AdMob registration.
        manifestPlaceholders["megaAdMobAppId"] = adMobAppId
        // The two owner-approved ad units this build may present, or "" for none. Never a live unit
        // by default and never a real id invented here; the test units a device pass needs are
        // supplied as build properties, exactly like the app id above.
        buildConfigField("String", "MEGA_ADMOB_REWARDED_UNIT", "\"$adMobRewardedUnit\"")
        buildConfigField("String", "MEGA_ADMOB_INTERSTITIAL_UNIT", "\"$adMobInterstitialUnit\"")
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        if (releaseSigningConfigured) {
            create("v5Release") {
                storeFile = file(releaseStorePath!!)
                storePassword = releaseStorePassword!!
                keyAlias = releaseKeyAlias!!
                keyPassword = releaseKeyPassword!!
            }
        }
    }

    buildTypes {
        getByName("debug") {
            isDebuggable = true
            // Test units only: Google's own demo units unless the owner named others. A debug build
            // that reaches the provider therefore never presents live inventory, even though the
            // bridge is fully exercisable there.
            buildConfigField("String", "MEGA_ADMOB_REWARDED_UNIT", "\"$debugAdMobRewardedUnit\"")
            buildConfigField("String", "MEGA_ADMOB_INTERSTITIAL_UNIT",
                "\"$debugAdMobInterstitialUnit\"")
        }
        getByName("release") {
            isMinifyEnabled = false
            isDebuggable = false
            if (releaseSigningConfigured) {
                signingConfig = signingConfigs.getByName("v5Release")
            }
            // Signing alone is NOT P20 acceptance or authorization to upload:
            // this bundle remains offline until P05/P20 API is integrated.
        }
    }

    sourceSets.getByName("main").assets.srcDir(generatedAssets)
    sourceSets.getByName("main").java.srcDir(identitySources)
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    // Kotlin 2.4.20 is required by Google ID 1.2.1 (Kotlin metadata 2.4).

}

// Direct release tasks and aggregate builds must not emit a signed artefact
// under the nonproduction prototype package or without an owner-held key.
// Do not affect assembleDebug/emulator CI. "bundleRelease" is an internal
// build checkpoint only, not an authorization for Play distribution.
tasks.matching {
    it.name in setOf("packageRelease", "bundleRelease", "assembleRelease")
}.configureEach {
    doFirst {
        check(nativeAppId != "online.megaxo.prototype" &&
              Regex("^[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z][a-zA-Z0-9_]*){2,}$").matches(nativeAppId)) {
            "A real registered Android package ID is required for release"
        }
        check(nativeVersionCode > 0 &&
              nativeVersionName.isNotBlank() &&
              nativeVersionName != "0.1.0-native-dev") {
            "Release requires explicit positive versionCode and approved versionName"
        }
        check(releaseSigningConfigured &&
              releaseStorePath != null &&
              File(releaseStorePath).isFile) {
            "Release signing requires an existing owner-held keystore and all four MEGA_ANDROID_RELEASE_* values"
        }
    }
}

tasks.matching { it.name.startsWith("compile") && it.name.endsWith("Kotlin") }.configureEach {
    dependsOn(stageGoogleIdentitySource)
}

// Anything that consumes the generated asset directory must depend on its producer. Matching only
// on "merge*Assets" task names missed the lint model tasks (generate<Variant>LintVitalReportModel),
// which also read build/generated/megaAssets; ASSEMBLE RELEASE then failed with an implicit-dependency
// error. Name both families explicitly rather than inspecting the whole task graph, which forced
// lazy task properties to resolve too early and broke the debug build.
tasks.matching {
    (it.name.startsWith("merge") && it.name.endsWith("Assets")) ||
        it.name.contains("LintVitalReportModel") || it.name.contains("LintVitalAnalyze") ||
        it.name.startsWith("lintVitalAnalyze") || it.name.startsWith("lintAnalyze")
}.configureEach {
    dependsOn(generateMegaClient)
}

dependencies {
    implementation("androidx.webkit:webkit:1.13.0")
    // Latest verified stable Credential Manager and Google ID versions (Oct 2026).
    implementation("androidx.credentials:credentials:1.6.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.6.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.2.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.android.billingclient:billing:9.1.0")
    implementation("com.google.android.ump:user-messaging-platform:4.0.0")
    implementation("com.google.android.libraries.ads.mobile.sdk:ads-mobile-sdk:1.4.0")
}
