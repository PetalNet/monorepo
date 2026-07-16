package dev.petalcat.point_app

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val channelName = "dev.petalcat.point/battery_optimization"
    private val fgsChannelName = "dev.petalcat.point/foreground_service"

    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        // Mark the app's own Flutter engine as attached so a (re)start of the
        // foreground service does NOT spin a second, headless engine (DEFECT #2
        // / R9): the app is already driving the Dart location engine.
        PointForegroundService.appEngineAttached = true
        super.onCreate(savedInstanceState)
    }

    override fun onDestroy() {
        PointForegroundService.appEngineAttached = false
        super.onDestroy()
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "isIgnoringBatteryOptimizations" ->
                        result.success(isIgnoringBatteryOptimizations())
                    "requestIgnoreBatteryOptimizations" ->
                        result.success(openBatteryOptimizationSetting())
                    else -> result.notImplemented()
                }
            }
        // DEFECT #2: start/stop OUR OWN persistent location foreground service.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, fgsChannelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "start" -> {
                        PointForegroundService.start(applicationContext)
                        result.success(null)
                    }
                    "stop" -> {
                        PointForegroundService.stop(applicationContext)
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    private fun isIgnoringBatteryOptimizations(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        return powerManager.isIgnoringBatteryOptimizations(packageName)
    }

    private fun openBatteryOptimizationSetting(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
            isIgnoringBatteryOptimizations()
        ) return true

        val packageUri = Uri.parse("package:$packageName")
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, packageUri)
        if (startIfAvailable(direct)) return true

        val list = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        if (startIfAvailable(list)) return true

        return startIfAvailable(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri))
    }

    private fun startIfAvailable(intent: Intent): Boolean = try {
        if (intent.resolveActivity(packageManager) == null) {
            false
        } else {
            startActivity(intent)
            true
        }
    } catch (_: ActivityNotFoundException) {
        false
    } catch (_: SecurityException) {
        false
    }
}
