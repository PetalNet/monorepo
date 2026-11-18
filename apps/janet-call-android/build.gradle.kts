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
		versionCode = 1
		versionName = "0.1.0"
	}

	buildFeatures {
		buildConfig = true
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
	implementation("com.squareup.okhttp3:okhttp:4.12.0")
	testImplementation("junit:junit:4.13.2")
	testImplementation("org.json:json:20240303")
}
