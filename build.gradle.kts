import org.jetbrains.compose.desktop.application.dsl.TargetFormat

plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
    kotlin("plugin.compose") version "2.0.21"
    id("com.github.jengelman.shadow") version "8.1.1"
    application
}

group = "com.codex.launcher"
version = "1.0.0-SNAPSHOT"

repositories {
    mavenCentral()
    maven { url = uri("https://maven.pkg.jetbrains.space/public/p/compose/dev") }
    maven { url = uri("https://plugins.jetbrains.com/m2/") }
    google()
    gradlePluginPortal()
}

kotlin {
    jvmToolchain(21)
}

compose.desktop {
    application {
        mainClass = "com.codex.launcher.Main"
        nativeDistributions {
            targetFormats(TargetFormat.Dmg, TargetFormat.Exe, TargetFormat.AppImage)
            packageName = "Better Client Launcher"
            packageVersion = "1.0.0"
            // Windows
            windows {
                signingOptions {
                    // certificateSubject = "CN=Your Company"
                    // timestampUrl = "http://timestamp.digicert.com"
                }
            }
            // macOS
            macOS {
                bundleId = "com.codex.betterclient.launcher"
                signingOptions {
                    // identity = "Developer ID Application: Your Name (TEAM_ID)"
                }
            }
            // Linux
            linux {
                maintainer = "Jonas"
                category = "Game"
            }
        }
        // JVM args for the packaged app
        jvmOptions = listOf(
            "-Xmx2G",
            "-XX:+UseG1GC",
            "-Dprism.order=sw", // Software rendering fallback
            "-Dsun.java2d.uiScale=1.0"
        )
    }
}

// Compose compiler options
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    kotlinOptions.freeCompilerArgs += listOf(
        "-Xopt-in=kotlin.RequiresOptIn",
        "-Xopt-in=kotlinx.serialization.ExperimentalSerializationApi",
        "-Xopt-in=org.jetbrains.compose.desktop.ExperimentalComposeDesktopApi",
        "-P", "plugin:compose.compiler:generateKotlinFunctionClasses=true",
        "-P", "plugin:compose.compiler:metricsDestination=build/compose-metrics"
    )
}

dependencies {
    // Compose BOM
    val composeBom = platform("org.jetbrains.compose:compose-bom:1.7.3")
    implementation(composeBom)

    // Compose Desktop (Material 3)
    implementation("org.jetbrains.compose.material3:material3")
    implementation("org.jetbrains.compose.material3:material3-window-size-class")
    implementation("org.jetbrains.compose.ui:ui-graphics")
    implementation("org.jetbrains.compose.ui:ui-tooling-preview")
    implementation("org.jetbrains.compose.runtime:runtime-livedata")
    implementation("org.jetbrains.compose.runtime:runtime-rxjava3")

    // Compose Compiler (handled by plugin)

    // Skia / Graphics
    implementation("org.jetbrains.skia:skija-jvm:1.1.1")
    implementation("org.jetbrains.skia:skija-shared:1.1.1")

    // Serialization (for config/presets)
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-yaml:1.7.1")

    // Coroutines & Flow
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-swing:1.8.1")

    // Settings/Config
    implementation("com.fasterxml.jackson.core:jackson-databind:2.18.0")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.18.0")
    implementation("org.yaml:snakeyaml:2.3")

    // HTTP Client (for version manifest, auth, updates)
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okio:okio:3.9.1")

    // Logging
    implementation("org.slf4j:slf4j-api:2.0.16")
    implementation("ch.qos.logback:logback-classic:1.5.13")

    // Lottie Animation (for scene animations)
    implementation("com.airbnb.android:lottie-compose:6.2.0")

    // Image loading (for scene thumbnails)
    implementation("io.coil-kt:coil-compose:2.7.0")

    // Local platform dependency on the addon (for config schema generation later)
    implementation(project(":"))

    // Testing
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:2.0.21")
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.0")
}

tasks {
    // JVM target
    withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
        kotlinOptions {
            jvmTarget = "21"
            freeCompilerArgs += listOf(
                "-Xopt-in=kotlin.RequiresOptIn",
                "-Xopt-in=kotlinx.serialization.ExperimentalSerializationApi",
                "-Xopt-in=org.jetbrains.compose.desktop.ExperimentalComposeDesktopApi"
            )
        }
    }

    // Run task configuration
    run {
        jvmArgs(
            "-Dprism.order=sw",
            "-Dsun.java2d.uiScale=1.0"
        )
    }

    // Shadow jar for fat jar (optional, for testing)
    named<com.github.jengelman.gradle.plugins.shadow.tasks.ShadowJar>("shadowJar") {
        archiveClassifier.set("")
        manifest {
            attributes["Main-Class"] = "com.codex.launcher.MainKt"
        }
        mergeServiceFiles()
    }
}

application {
    mainClass.set("com.codex.launcher.MainKt")
}