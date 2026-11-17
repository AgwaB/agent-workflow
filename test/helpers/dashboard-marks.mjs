/**
 * Every piece of text the page shows (text nodes, titles, accessible names, the tab title) that
 * has a middle dot or an em dash (owner, pass 2). The decoration is layout, not characters.
 */
export const scanMarks = (browser) =>
	browser.evaluate(() => {
		const marks = /[·—]/u;
		const found = [];
		const walker = document.createTreeWalker(
			document.body,
			NodeFilter.SHOW_TEXT,
		);
		let node;
		while ((node = walker.nextNode())) {
			if (node.parentElement.closest("script,style,template")) continue;
			if (marks.test(node.textContent))
				found.push(`text: ${node.textContent.trim().slice(0, 80)}`);
		}
		for (const element of document.querySelectorAll(
			"[title],[aria-label],[placeholder],[data-label]",
		))
			for (const name of ["title", "aria-label", "placeholder", "data-label"])
				if (marks.test(element.getAttribute(name) ?? ""))
					found.push(`${name}: ${element.getAttribute(name).slice(0, 80)}`);
		if (marks.test(document.title))
			found.push(`document.title: ${document.title}`);
		return found;
	});
