import com.android.build.api.dsl.ApplicationExtension
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

extensions.configure<ApplicationExtension> {
    namespace = "dev.petalcat.point_app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "dev.petalcat.point_app"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName

        // R11/R12 — the Rust bridge (point_mls/point_core) ships arm64-v8a .so
        // only. Restrict packaged native code to arm64-v8a so the built APK is
        // honestly arm64-only and F-Droid stops advertising it to 32-bit/x86
        // devices (where the missing libs → an instant crash, the 1.2.11
        // symptom). Also drops the stray x86_64 jniLibs the Rust script emits.
        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    // R11/R12 — belt to abiFilters' suspenders. `abiFilters` / `--target-platform
    // android-arm64` restrict Flutter's OWN engine libs, but PREBUILT jniLibs
    // slip through: the Rust script's x86_64 libpoint_*.so and a plugin's
    // libdartjni.so stubs for armeabi-v7a/x86_64. Any non-arm64 `lib/<abi>/`
    // directory makes F-Droid advertise the APK to that ABI's devices — which
    // then crash on the missing arm64-only bridge. Physically exclude every
    // non-arm64 ABI from packaging so the APK is honestly arm64-only.
    packaging {
        jniLibs {
            excludes += setOf(
                "**/armeabi/**",
                "**/armeabi-v7a/**",
                "**/x86/**",
                "**/x86_64/**",
                "**/mips/**",
                "**/mips64/**",
            )
        }
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_11)
    }
}

flutter {
    source = "../.."
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
}

// The UnifiedPush connector's WebPush layer pulls the JVM `tink` jar while
// flutter_secure_storage pulls `tink-android`; both ship the same classes and
// Gradle refuses the duplicate. tink-android is the Android packaging of the
// same library, so keep it and drop the JVM jar everywhere.
configurations.all {
    exclude(group = "com.google.crypto.tink", module = "tink")
}
