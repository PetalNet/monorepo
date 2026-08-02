import { expect, test } from "@playwright/test";

test("login renders the themed SSO entry point", async ({ page }) => {
	await page.goto("/login");
	await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Sign in with SSO" })).toBeVisible();
	await expect(page.locator("main section.card")).toHaveCSS("display", "flex");
});
