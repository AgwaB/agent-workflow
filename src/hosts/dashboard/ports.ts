/** Ordered bind candidates; zero asks the OS for an ephemeral port. No I/O. */
export function dashboardPortCandidates(options: {
	explicit?: number;
	customHome: boolean;
	lastPort?: number;
}): number[] {
	if (options.explicit !== undefined) return [options.explicit];
	if (options.customHome) return options.lastPort ? [options.lastPort, 0] : [0];
	return [...Array.from({ length: 10 }, (_, index) => 7417 + index), 0];
}
