import { collegeDomains } from './collegeDomains';

/** Normalize a college name for lookup: lowercase, strip "the", normalize separators */
function normalize(name: string): string {
	return name
		.toLowerCase()
		.replace(/^the /, '')
		.replace(/-/g, ' ')
		.replace(/,/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Try multiple name variations to find a match in the domain map */
function findDomain(collegeName: string): string | null {
	const norm = normalize(collegeName);

	// Direct lookup
	const direct = collegeDomains.get(norm);
	if (direct) return direct;

	// Try original lowercase
	const lower = collegeName.toLowerCase().trim();
	const lower2 = collegeDomains.get(lower);
	if (lower2) return lower2;

	// Try with commas instead of dashes: "University of California-Berkeley" → "university of california, berkeley"
	const withCommas = norm.replace(/ (?=berkeley|los angeles|san diego|davis|santa barbara|irvine|riverside|santa cruz|san francisco)/, ', ');
	const c = collegeDomains.get(withCommas);
	if (c) return c;

	// Try stripping campus suffixes like "-Main Campus", "-Tempe", "-Oxford"
	const stripped = norm
		.replace(/ main campus$/, '')
		.replace(/ tempe$/, '')
		.replace(/ oxford$/, '')
		.replace(/ provo$/, '')
		.replace(/ north newton$/, '')
		.replace(/ dayton$/, '')
		.replace(/ indiana$/, '')
		.replace(/ fort wayne$/, '')
		.replace(/ lamoni$/, '')
		.replace(/ st augustine$/, '')
		.replace(/ ft lauderdale$/, '')
		.replace(/ colorado springs$/, '')
		.replace(/ phoenix campus$/, '')
		.replace(/ at kent$/, '')
		.replace(/ at .*$/, '');
	if (stripped !== norm) {
		const s = collegeDomains.get(stripped);
		if (s) return s;
	}

	return null;
}

export function getLogoUrl(collegeName: string, size = 64): string | null {
	const domain = findDomain(collegeName);
	if (!domain) return null;
	return `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}`;
}
