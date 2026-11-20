const phrase = "amber orchard lantern twelve";

switch (process.env["TEST_PROVIDER_MODE"] ?? "valid") {
	case "fail":
		process.stdout.write(phrase);
		process.stderr.write(phrase);
		process.exitCode = 1;

		break;
	case "hang":
		setTimeout(() => process.stdout.write("late provider output"), 60_000);

		break;
	case "large":
		process.stdout.write("x".repeat(17 * 1024 * 1024));

		break;
	case "invalid":
		process.stdout.write(`not JSON: ${phrase}`);

		break;
	case "schema":
		process.stdout.write(JSON.stringify({ privateEntry: [phrase] }));

		break;
	case "empty":
		process.stdout.write("{}");

		break;
	case "empty-fields":
		process.stdout.write('{"privateEntry":{}}');

		break;
	default:
		process.stdout.write(
			JSON.stringify({
				privateEntry: phrase,
				structured: { password: "violet river window nine", label: "public application label" },
				short: "tiny",
				path: "/var/lib/example/settings",
				url: "https://example.org/documentation",
				credentials: "https://reader:aaaaaaa@example.org",
				query: "https://example.org/?session=aaaaaaa",
				fragment: "https://example.org/#credential",
				multiline: "first synthetic line\nsecond synthetic line",
			}),
		);
}
