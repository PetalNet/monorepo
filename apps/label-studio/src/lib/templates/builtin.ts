/** The read-only gallery: every built-in template, grouped by category in display order. */
import type { Template } from "$lib/doc";

import { GARDEN } from "./garden.ts";
import { HOME } from "./home.ts";
import { KITCHEN } from "./kitchen.ts";
import { LAB } from "./lab.ts";
import { OFFICE } from "./office.ts";
import { PERSONAL } from "./personal.ts";
import { QR } from "./qr.ts";
import { SAFETY } from "./safety.ts";
import { SCHOOL } from "./school.ts";

export const BUILTIN_TEMPLATES: Template[] = [
	...LAB,
	...HOME,
	...KITCHEN,
	...OFFICE,
	...SCHOOL,
	...SAFETY,
	...GARDEN,
	...PERSONAL,
	...QR,
];
