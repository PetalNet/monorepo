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
        // Defect #1-remnant: drop the promotion bridge with the engine it targets.
        PointForegroundService.promotionListener = null
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
        val fgsChannel =
            MethodChannel(flutterEngine.dartExecutor.binaryMessenger, fgsChannelName)
        fgsChannel.setMethodCallHandler { call, result ->
            when (call.method) {
                "start" -> {
                    // Defect #5: report whether the OS accepted the start so
                    // the Dart engine confirms + re-arms instead of latching.
                    result.success(PointForegroundService.start(applicationContext))
                }
                "stop" -> {
                    PointForegroundService.stop(applicationContext)
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
        // Defect #1-remnant: the accepted start is NOT the survival-critical
        // signal — the async `startForeground` PROMOTION (in the service's
        // onStartCommand) is. Bridge its result back to the Dart engine so it
        // latches the FGS running only on a CONFIRMED promotion and re-arms on a
        // promotion refusal. invokeMethod must run on the platform (UI) thread.
        PointForegroundService.promotionListener = { promoted ->
            runOnUiThread { fgsChannel.invokeMethod("onForegroundPromotion", promoted) }
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
