// /fx — ECB daily reference-rate XML, proxied server-side so the browser stays
// same-origin (no third-party call from the client). Ported from server.js;
// fed to Numbat's set_exchange_rates() for live currency conversion. Cached ~6h
// (ECB publishes once per weekday).

let _fx: { xml: string | null; at: number } = { xml: null, at: 0 };
const FX_TTL = 6 * 3600e3;

async function getFX(): Promise<string> {
	if (_fx.xml && Date.now() - _fx.at < FX_TTL) return _fx.xml;

	const r = await fetch("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml", {
		signal: AbortSignal.timeout(8000),
	});

	if (!r.ok) throw new Error("ecb " + r.status);

	const xml = await r.text();

	_fx = { xml, at: Date.now() };

	return xml;
}

export async function GET() {
	try {
		const xml = await getFX();

		return new Response(xml, {
			headers: {
				"Content-Type": "application/xml; charset=utf-8",
				"Cache-Control": "max-age=3600",
			},
		});
	} catch {
		return new Response("fx unavailable", {
			status: 502,
			headers: { "Content-Type": "text/plain" },
		});
	}
}
