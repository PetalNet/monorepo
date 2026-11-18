plugins {
	id("com.android.application") version "9.0.1"
	// The Kotlin version the Android plugin above compiles with.
	id("org.jetbrains.kotlin.plugin.compose") version "2.4.21"
}

android {
	namespace = "dev.petalcat.janetcall"
	compileSdk = 36

	defaultConfig {
		applicationId = "dev.petalcat.janetcall"
		minSdk = 26
		targetSdk = 35
		versionCode = 11
		versionName = "0.7.0"
	}

	buildFeatures {
		buildConfig = true
		compose = true
	}

	testOptions {
		unitTests {
			// The screen tests draw the real screens, with the app's font and planet.
			isIncludeAndroidResources = true
			all { it.systemProperty("roborazzi.test.record", "true") }
		}
	}

	lint {
		// minSdk is 26. The unit tests run on the host JDK, which has calls Android 8 does not
		// (LocalDate.ofInstant is API 34), so only lint can see a call the oldest phone lacks.
		checkOnly += "NewApi"
		abortOnError = true
	}

	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_17
		targetCompatibility = JavaVersion.VERSION_17
	}

	buildTypes {
		release {
			// Same as Rolo: the release APK is signed with the machine's debug keystore.
			// There is no keystore or password in this repository.
			signingConfig = signingConfigs.getByName("debug")
		}
	}
}

dependencies {
	// OkHttp 5.5 needs compileSdk 37, which no released Android Gradle plugin builds against yet.
	// .github/renovate.json holds it below 5 until this project can compile against 37.
	implementation("com.squareup.okhttp3:okhttp:4.12.1")
	implementation(platform("androidx.compose:compose-bom:2025.12.01"))
	implementation("androidx.compose.foundation:foundation")
	implementation("androidx.compose.material3:material3")
	implementation("androidx.activity:activity-compose:1.13.0")
	implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.2.0")
	testImplementation("junit:junit:4.13.2")
	testImplementation("org.json:json:20240303")
	testImplementation("org.robolectric:robolectric:4.17")
	testImplementation("io.github.takahirom.roborazzi:roborazzi:1.78.0")
	testImplementation("androidx.test:core:1.7.0")
}

androidComponents {
	beforeVariants(selector().withBuildType("release")) { builder ->
		builder.hostTests["UnitTest"]?.enable = true
	}
}
