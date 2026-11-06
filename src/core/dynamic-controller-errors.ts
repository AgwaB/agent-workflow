export class DynamicControllerSuspended extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DynamicControllerSuspended";
	}
}

export class DynamicControllerBudgetBlocked extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DynamicControllerBudgetBlocked";
	}
}
