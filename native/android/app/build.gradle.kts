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
        applicationId = providers.gradleProperty("megaApplicationId").get()
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0-native-dev"
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        getByName("debug") {
            isDebuggable = true
        }
        getByName("release") {
            isMinifyEnabled = false
            // No distribution signing identity is checked into source control.
        }
    }

    sourceSets.getByName("main").assets.srcDir(generatedAssets)
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach {
    dependsOn(generateMegaClient)
}

dependencies {
    implementation("androidx.webkit:webkit:1.13.0")
}
