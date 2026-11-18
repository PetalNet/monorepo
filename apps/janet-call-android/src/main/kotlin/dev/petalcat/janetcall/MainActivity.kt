package dev.petalcat.janetcall

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.telecom.CallAudioState
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Pairing and the in-call UI. Self-managed calls get no system dialer screen, so this is the call screen.
 * A pairing link (`janetcall://pair?u=...`) can come from any app or web page, so nothing is sent or
 * stored until the person confirms the bridge host it names.
 */
class MainActivity : Activity() {
	private lateinit var title: TextView
	private lateinit var body: TextView
	private lateinit var primary: Button
	private lateinit var secondary: Button
	private val settings by lazy { Settings(this) }
	private val observer: () -> Unit = { render() }

	/** The `u` payload of a pairing link waiting for confirmation. */
	private var pendingPayload: String? = null
	private var pairingWith: String? = null
	private var notice: String? = null

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		val dp = resources.displayMetrics.density
		fun pad(v: Int) = (v * dp).toInt()

		title = TextView(this).apply { textSize = 22f }
		body = TextView(this).apply {
			textSize = 16f
			setPadding(0, pad(8), 0, pad(20))
		}
		primary = Button(this)
		secondary = Button(this)
		val column = LinearLayout(this).apply {
			orientation = LinearLayout.VERTICAL
			setPadding(pad(20), pad(24), pad(20), pad(24))
			listOf(title, body, primary, secondary).forEach(::addView)
		}
		setContentView(column)
		window.decorView.setOnApplyWindowInsetsListener { v, insets ->
			v.setPadding(0, insets.systemWindowInsetTop, 0, insets.systemWindowInsetBottom)
			insets
		}
		pendingPayload = savedInstanceState?.getString(PENDING)
		takePairingLink(intent)
	}

	override fun onNewIntent(intent: Intent) {
		super.onNewIntent(intent)
		takePairingLink(intent)
		render()
	}

	override fun onSaveInstanceState(outState: Bundle) {
		super.onSaveInstanceState(outState)
		outState.putString(PENDING, pendingPayload)
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

	private fun takePairingLink(intent: Intent) {
		val data = intent.data ?: return
		// Consumed here, so a rotation or a relaunch from recents does not ask again.
		setIntent(Intent(this, MainActivity::class.java))
		if (intent.action != Intent.ACTION_VIEW || data.scheme != "janetcall" || data.host != "pair") return
		pendingPayload = data.getQueryParameter("u").orEmpty()
		notice = null
	}

	private fun pendingLink(): PairingLink? {
		val payload = pendingPayload ?: return null
		return when (val parsed = parsePairingPayload(payload, System.currentTimeMillis() / 1000, BuildConfig.DEBUG)) {
			is PairingParse.Ok -> parsed.link
			is PairingParse.Bad -> {
				pendingPayload = null
				notice = parsed.reason
				null
			}
		}
	}

	private fun show(heading: String, text: String, first: Pair<String, () -> Unit>?, second: Pair<String, () -> Unit>?) {
		title.text = heading
		body.text = text
		listOf(primary to first, secondary to second).forEach { (button, action) ->
			button.visibility = if (action == null) View.GONE else View.VISIBLE
			button.text = action?.first
			button.setOnClickListener { action?.second?.invoke() }
		}
	}

	private fun render() {
		val state = Calls.state
		val link = if (Calls.inCall || pairingWith != null) null else pendingLink()
		val pairing = settings.pairing()
		when {
			Calls.inCall -> show(
				if (state is CallState.Active) "In call with Janet" else "Calling Janet…",
				Calls.route,
				"Hang up" to { Calls.connection?.hangup() ?: Unit },
				"Speaker" to { toggleSpeaker() },
			)
			pairingWith != null -> show("Pairing with $pairingWith…", "", null, null)
			link != null -> show(
				"Pair this phone with ${link.host}?",
				"Janet Call will place its calls through ${link.host}" +
					(if (pairing != null) ", in place of ${pairing.host}" else "") +
					". Continue only if you opened the pairing page yourself.",
				"Pair" to { pair(link) },
				"Cancel" to {
					pendingPayload = null
					render()
				},
			)
			pairing == null -> show(
				"Not paired",
				notice ?: "Open the pairing page on a computer and scan the code with this phone's camera.",
				null,
				null,
			)
			else -> show(
				pairing.host,
				notice ?: (state as? CallState.Ended)?.reason ?: "Ready",
				"Call Janet" to { requestCall() },
				"Unpair" to { confirmUnpair() },
			)
		}
	}

	private fun pair(link: PairingLink) {
		pendingPayload = null
		pairingWith = link.host
		render()
		val store = Settings(applicationContext)
		Thread({
			val result = Bridge.pair(link, "${Build.MANUFACTURER} ${Build.MODEL}")
			if (result is PairResult.Paired) store.save(result.pairing)
			runOnUiThread {
				pairingWith = null
				notice = (result as? PairResult.Refused)?.reason
				render()
			}
		}, "janet-pair").start()
	}

	private fun confirmUnpair() {
		AlertDialog.Builder(this)
			.setMessage("Unpair this phone? To call Janet again you will need the pairing page.")
			.setPositiveButton("Unpair") { _, _ ->
				settings.clear()
				notice = null
				render()
			}
			.setNegativeButton("Cancel", null)
			.show()
	}

	private fun toggleSpeaker() {
		val speakerOn = Calls.route == "Speaker"
		Calls.connection?.setRoute(if (speakerOn) CallAudioState.ROUTE_EARPIECE else CallAudioState.ROUTE_SPEAKER)
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
			notice = "Janet needs the microphone to take a call"
			render()
		}
	}

	private fun placeCall() {
		notice = Dialer.place(this)
		render()
	}

	private companion object {
		const val PENDING = "pending_pairing_payload"
	}
}
