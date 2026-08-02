export interface InvestigationSeed {
	title: string;
	queryRef: string;
	panelTitle: string;
	panelType: "bar" | "line" | "stat" | "table" | "scatter";
	selectedField: string;
	selectedValue: string | number | boolean;
}
