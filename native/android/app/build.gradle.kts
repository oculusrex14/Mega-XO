import org.gradle.api.tasks.Exec

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val repoRoot = rootProject.projectDir.resolve("../..").canonicalFile
val generatedAssets = layout.buildDirectory.dir("generated/megaAssets")
val generateMegaClient = tasks.register<Exec>("generateMegaClient") {
    description = "Package only approved Mega XO client assets for offline Android gameplay"
    group = "build"
    val bundleDir = generatedAssets.get().asFile.resolve("mega")
    inputs.file(repoRoot.resolve("native/client/bundle.config.json"))
    inputs.file(repoRoot.resolve("index.html"))
    inputs.files(fileTree(repoRoot.resolve("src")), fileTree(repoRoot.resolve("public")), fileTree(repoRoot.resolve("assets/vendor")))
    outputs.dir(bundleDir)
    commandLine(
        "node",
        repoRoot.resolve("scripts/v5/build-client.js").absolutePath,
        "--root", repoRoot.absolutePath,
        "--output", bundleDir.absolutePath
    )
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
