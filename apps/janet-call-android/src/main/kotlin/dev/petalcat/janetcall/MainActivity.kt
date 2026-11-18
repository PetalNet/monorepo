package dev.petalcat.janetcall

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.telecom.CallAudioState
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** The in-call UI: self-managed calls get no system dialer screen, so this is the call screen. */
class MainActivity : Activity() {
	private lateinit var status: TextView
	private lateinit var call: Button
	private lateinit var hangUp: Button
	private lateinit var speaker: Button
	private lateinit var url: EditText
	private lateinit var token: EditText
	private lateinit var cfId: EditText
	private lateinit var cfSecret: EditText
	private val settings by lazy { Settings(this) }
	private val observer: () -> Unit = { render() }

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		val dp = resources.displayMetrics.density
		fun pad(v: Int) = (v * dp).toInt()

		fun button(label: String, onClick: () -> Unit) = Button(this).apply {
			text = label
			setOnClickListener { onClick() }
		}

		fun field(hint: String, secret: Boolean = false) = EditText(this).apply {
			this.hint = hint
			setSingleLine()
			inputType = InputType.TYPE_CLASS_TEXT or
				if (secret) InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_TEXT_VARIATION_URI
		}

		status = TextView(this).apply { textSize = 20f }
		call = button("Call Janet") { requestCall() }
		hangUp = button("Hang up") { Calls.connection?.hangup() }
		speaker = button("Speaker") {
			val speakerOn = Calls.route == "Speaker"
			Calls.connection?.setRoute(if (speakerOn) CallAudioState.ROUTE_EARPIECE else CallAudioState.ROUTE_SPEAKER)
		}
		url = field("Bridge URL (wss://…/v1/call)")
		token = field("Bearer token", secret = true)
		cfId = field("Cloudflare Access client id")
		cfSecret = field("Cloudflare Access client secret", secret = true)
		val save = button("Save settings") { save() }

		val column = LinearLayout(this).apply {
			orientation = LinearLayout.VERTICAL
			setPadding(pad(20), pad(24), pad(20), pad(24))
			listOf(status, call, hangUp, speaker, url, token, cfId, cfSecret, save).forEach(::addView)
		}
		setContentView(ScrollView(this).apply { addView(column) })
		window.decorView.setOnApplyWindowInsetsListener { v, insets ->
			v.setPadding(0, insets.systemWindowInsetTop, 0, insets.systemWindowInsetBottom)
			insets
		}
		url.setText(settings.url)
		cfId.setText(settings.cfId)
		if (settings.hasToken) token.hint = "Bearer token (saved, leave blank to keep)"
		if (settings.hasCfSecret) cfSecret.hint = "Client secret (saved, leave blank to keep)"
	}

	override fun onStart() {
		super.onStart()
		Calls.observe(observer)
		render()
	}

	override fun onStop() {
		Calls.unobserve(observer)
		super.onStop()
	}

	private fun render() {
		val state = Calls.state
		status.text = when (state) {
			CallState.Idle -> "Ready"
			CallState.Connecting -> "Calling Janet…"
			CallState.Active -> "In call with Janet" + Calls.route.let { if (it.isEmpty()) "" else " ($it)" }
			is CallState.Ended -> state.reason
		}
		call.isEnabled = !Calls.inCall
		listOf(hangUp, speaker).forEach { it.visibility = if (Calls.inCall) View.VISIBLE else View.GONE }
	}

	private fun save() {
		settings.save(
			url.text.toString(),
			token.text.toString().ifBlank { null },
			cfId.text.toString(),
			cfSecret.text.toString().ifBlank { null },
		)
		token.text.clear()
		cfSecret.text.clear()
		status.text = settings.config().problem() ?: "Settings saved"
	}

	private fun requestCall() {
		val needed = buildList {
			add(Manifest.permission.RECORD_AUDIO)
			if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
		}.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
		if (needed.isEmpty()) placeCall() else requestPermissions(needed.toTypedArray(), 1)
	}

	override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, results: IntArray) {
		if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
			placeCall()
		} else {
			status.text = "Janet needs the microphone to take a call"
		}
	}

	private fun placeCall() {
		Dialer.place(this)?.let { status.text = it }
	}
}
