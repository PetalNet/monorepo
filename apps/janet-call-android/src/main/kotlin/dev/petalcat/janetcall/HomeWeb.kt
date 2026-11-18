package dev.petalcat.janetcall

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import dev.petalcat.janetcall.ui.LocalPalette
import dev.petalcat.janetcall.ui.Type
import java.net.URI
import java.net.URISyntaxException

/** Where the home page is until Settings says otherwise. */
const val DEFAULT_HOME_URL = "https://tasks.petalcat.dev/janet/home"

/** The sign-in page the home page sends the WebView to. Its host is the only other one the WebView opens. */
const val AUTH_HOST = "auth.petalcat.dev"

/** The home page address, kept apart from the pairing so unpairing does not lose it. Not a secret. */
class AppConfig(context: Context) {
	private val prefs = context.getSharedPreferences("janet_call_app", Context.MODE_PRIVATE)

	fun homeUrl(): String = prefs.getString(HOME, null)?.takeIf { homeUrlProblem(it) == null } ?: DEFAULT_HOME_URL

	/** Returns why [url] is not usable, or null once it is saved. A blank address puts the default back. */
	fun setHomeUrl(url: String): String? {
		val trimmed = url.trim()
		if (trimmed.isEmpty() || trimmed == DEFAULT_HOME_URL) {
			prefs.edit().remove(HOME).apply()
			return null
		}
		homeUrlProblem(trimmed)?.let { return it }
		prefs.edit().putString(HOME, trimmed).apply()
		return null
	}

	private companion object {
		const val HOME = "home_url"
	}
}

/** A reason [url] cannot be the home page, or null. Only https, with a host, and no sign-in embedded in it. */
fun homeUrlProblem(url: String): String? {
	val uri = try {
		URI(url)
	} catch (_: URISyntaxException) {
		return "That is not a web address."
	}
	return when {
		uri.scheme?.lowercase() != "https" -> "The home page address must start with https://"
		uri.host.isNullOrEmpty() -> "That address has no host."
		uri.userInfo != null -> "The address cannot hold a user name or password."
		else -> null
	}
}

/** The hosts the home WebView may show: the home page's own, and the sign-in page. */
fun allowedHosts(homeUrl: String): Set<String> =
	setOfNotNull(runCatching { URI(homeUrl).host?.lowercase() }.getOrNull(), AUTH_HOST)

/** What to do with a link the home WebView was asked to follow. */
sealed interface LinkRoute {
	/** Start the native call, as the Call Janet button does. */
	data object Call : LinkRoute

	/** Show it in the WebView. */
	data object InView : LinkRoute

	/** Hand it to the browser. */
	data object Browser : LinkRoute

	/** Do nothing. */
	data object Block : LinkRoute
}

/**
 * `janetcall://call` starts a call, with or without a query. Any other janetcall link is ignored: a
 * pairing link must arrive from outside, where the app asks first. https to an allowed host stays in
 * the view, any other web address goes to the browser, and every other scheme is dropped.
 */
fun routeLink(url: String, allowed: Set<String>): LinkRoute {
	val uri = try {
		URI(url)
	} catch (_: URISyntaxException) {
		return LinkRoute.Block
	}
	val host = uri.host?.lowercase()
	return when (uri.scheme?.lowercase()) {
		"janetcall" -> if (host == "call") LinkRoute.Call else LinkRoute.Block
		"https" -> if (host != null && uri.userInfo == null && host in allowed) LinkRoute.InView else LinkRoute.Browser
		"http" -> LinkRoute.Browser
		else -> LinkRoute.Block
	}
}

/**
 * The home screen: Janet's page in a WebView under a slim bar that holds the one native control,
 * Settings. [fallback] is drawn instead when the page cannot load, and offers to try again.
 */
@Composable
fun HomeWeb(
	url: String,
	onCall: () -> Unit,
	onSettings: () -> Unit,
	fallback: @Composable (retry: () -> Unit) -> Unit,
) {
	var failed by remember { mutableStateOf(false) }
	var attempt by remember { mutableIntStateOf(0) }
	if (failed) {
		fallback {
			failed = false
			attempt++
		}
		return
	}
	val palette = LocalPalette.current
	var canGoBack by remember { mutableStateOf(false) }
	val web = remember { arrayOfNulls<WebView>(1) }
	BackHandler(enabled = canGoBack) { web[0]?.goBack() }
	Column(Modifier.fillMaxSize().background(palette.ground).statusBarsPadding().navigationBarsPadding()) {
		Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically) {
			Text("Janet", style = Type.name, color = palette.ink, modifier = Modifier.weight(1f).semantics { heading() })
			RoundButton(R.drawable.ic_settings, "Settings", size = 48, iconSize = 20, filled = false, onClick = onSettings)
		}
		androidx.compose.runtime.key(attempt) {
			AndroidView(
				modifier = Modifier.weight(1f).fillMaxWidth(),
				factory = { context ->
					val view = homeWebView(context, url, palette.ground.toArgb(), onCall, { failed = true }, { canGoBack = it })
					web[0] = view.webView
					view.layout
				},
				onRelease = {
					web[0]?.destroy()
					web[0] = null
				},
			)
		}
	}
}

private class HomeView(val layout: SwipeRefreshLayout, val webView: WebView)

@SuppressLint("SetJavaScriptEnabled")
private fun homeWebView(
	context: Context,
	url: String,
	ground: Int,
	onCall: () -> Unit,
	onFailed: () -> Unit,
	onHistory: (Boolean) -> Unit,
): HomeView {
	val allowed = allowedHosts(url)
	val webView = WebView(context)
	val layout = SwipeRefreshLayout(context)
	webView.setBackgroundColor(ground)
	webView.settings.apply {
		javaScriptEnabled = true
		domStorageEnabled = true
		// Only the page itself: nothing from the phone's files, no mixed content.
		allowFileAccess = false
		allowContentAccess = false
		mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
		setSupportMultipleWindows(false)
	}
	WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
	CookieManager.getInstance().apply {
		setAcceptCookie(true)
		setAcceptThirdPartyCookies(webView, false)
	}
	webView.webViewClient = object : WebViewClient() {
		override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
			when (routeLink(request.url.toString(), allowed)) {
				// A page can only start a call from a tap, never by redirecting on its own.
				LinkRoute.Call -> if (request.hasGesture()) onCall()
				LinkRoute.InView -> return false
				LinkRoute.Browser -> if (request.hasGesture()) {
					runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, request.url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
				}
				LinkRoute.Block -> Unit
			}
			return true
		}

		override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
			layout.isRefreshing = true
		}

		override fun onPageFinished(view: WebView, url: String?) {
			layout.isRefreshing = false
			CookieManager.getInstance().flush()
		}

		override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) = onHistory(view.canGoBack())

		override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
			if (request.isForMainFrame) onFailed()
		}

		override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
			if (request.isForMainFrame && (response.statusCode >= 500 || response.statusCode == 404)) onFailed()
		}

		override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
			onFailed()
			return true
		}
	}
	layout.addView(webView)
	// The page scrolls before the pull starts the refresh.
	layout.setOnChildScrollUpCallback { _, _ -> webView.scrollY > 0 }
	layout.setOnRefreshListener { webView.reload() }
	webView.loadUrl(url)
	return HomeView(layout, webView)
}

