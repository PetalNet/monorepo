import { lintConfig } from "../../../oxlint.config.ts";

export default {
	...lintConfig,
	options: { typeAware: false },
	ignorePatterns: [],
};
