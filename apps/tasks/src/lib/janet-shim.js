// The helper a published page inlines, so its script can talk to the trusted page around it.
// The page runs in an opaque-origin sandbox with no network, so every call is a postMessage to
// the parent, which checks who is asking and what the page may do. Nothing here is trusted:
// the parent takes the slug and the viewer from the page it served, never from these messages.
//
//   janet.send({ anchor, payload, ink? })  -> Promise of { id, rev, matrixEventId }
//   janet.on('revised' | 'resolved', fn)   -> fn(detail) when Janet revises the page / resolves an item
//   janet.me()                             -> Promise of { user }
//   janet.feedback()                       -> Promise of the viewer's own items on this page
export const JANET_SHIM = `(function () {
	var n = 0, waiting = {}, handlers = { revised: [], resolved: [] };
	function call(op, args) {
		return new Promise(function (ok, no) {
			var id = ++n;
			waiting[id] = [ok, no];
			parent.postMessage({ janet: op, id: id, args: args }, "*");
		});
	}
	addEventListener("message", function (e) {
		var d = e.data;
		if (e.source !== parent || !d) return;
		if (d.janet === "reply" && waiting[d.id]) {
			var w = waiting[d.id];
			delete waiting[d.id];
			if (d.ok) w[0](d.result); else w[1](new Error(d.error));
		} else if (d.janet === "event" && handlers[d.name]) {
			handlers[d.name].forEach(function (f) { f(d.detail); });
		}
	});
	window.janet = {
		send: function (a) { return call("send", a); },
		me: function () { return call("me"); },
		feedback: function () { return call("feedback"); },
		on: function (name, f) { (handlers[name] = handlers[name] || []).push(f); }
	};
})();`;
