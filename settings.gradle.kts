pluginManagement {
    repositories {
        mavenCentral()
        gradlePluginPortal()
        google()
        maven { url = uri("https://plugins.jetbrains.com/m2/") }
        maven { url = uri("https://maven.pkg.jetbrains.space/public/p/compose/dev") }
    }
}

rootProject.name = "launcher"