// The result, not the permanently visible "Saved profiles" panel heading.
export async function waitForSavedProfile(browser) {
	await browser.waitFor(() =>
		document.querySelector("#center")?.textContent.includes("Saved profile:"),
	);
}
