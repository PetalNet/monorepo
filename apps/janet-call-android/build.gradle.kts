plugins {
	id("com.android.application") version "9.0.1"
}

android {
	namespace = "dev.petalcat.janetcall"
	compileSdk = 35

	defaultConfig {
		applicationId = "dev.petalcat.janetcall"
		minSdk = 26
		targetSdk = 35
		versionCode = 5
		versionName = "0.2.2"
	}

	buildFeatures {
		buildConfig = true
	}

	testOptions {
		unitTests {
			isIncludeAndroidResources = true
			all { it.systemProperty("roborazzi.test.record", "true"); it.maxHeapSize = "1500m" }
		}
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
	testImplementation("junit:junit:4.13.2")
	testImplementation("org.json:json:20240303")
	testImplementation("org.robolectric:robolectric:4.14.1")
	testImplementation("io.github.takahirom.roborazzi:roborazzi:1.43.1")
	testImplementation("androidx.test:core:1.6.1")
}

androidComponents {
	beforeVariants(selector().withBuildType("release")) { builder ->
		builder.hostTests["UnitTest"]?.enable = true
	}
}
