const capabilities = {
	must: ["echo.cap"],
	prefer: ["echo.fast"],
};

const filters = [
	{ key: "domain", value: "*" },
	{ key: "locale", value: "zh-CN" },
];

const ranks = {
	cost: 1,
	quality: 1,
};

const flow = {
	id: "invoke_echo",
	start: "ret",
	steps: [
		{
			id: "ret",
			action: {
				type: "done",
				reason: "ok",
				conclusion: {
					echo: "${msg}",
					from: "invoke_echo",
				},
			},
			next: {},
		},
	],
};

export default { capabilities, filters, ranks, flow };
export { capabilities, filters, ranks, flow };
