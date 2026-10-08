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
        // Official test app ID for a non-distributing, offline prototype.
        // Real releases require an owner-verified AdMob registration.
        manifestPlaceholders["megaAdMobAppId"] =
            providers.gradleProperty("megaAdMobAppId").orNull
                ?: "ca-app-pub-3940256099942544~3347511713"
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

tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach {
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
