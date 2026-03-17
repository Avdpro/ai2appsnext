const capabilities = {
	must: ['search', 'search.query'],
	prefer: ['search.target', 'search.minResults', 'search.entityType', 'search.login'],
};

const filters = [{ key: 'domain', value: '*' }];

const flow = {
	id: 'search_on_current_page_impl',
	start: 'init_search_policy',
	args: {
		query: { type: 'string', required: true, desc: '搜索关键词或查询语句' },
		minResults: { type: 'number', required: false, desc: '期望最少返回结果数，默认 10' },
		search: { type: 'object', required: false, desc: '支持 search.query/search.minResults/search.login' },
	},
	steps: [
		{
			id: 'init_search_policy',
			desc: '标准化查询参数并按站点判定是否需要登录（search.login=auto|true|false）',
			action: {
				type: 'run_js',
				scope: 'agent',
				code: `function(input){
					function asStr(v){ return String(v == null ? '' : v).trim(); }
					function asNum(v, d){ const n = Number(v); return Number.isFinite(n) ? n : d; }
					function parseLoginMode(v){
						const s = asStr(v).toLowerCase();
						if (s === 'true' || s === 'required' || s === 'force' || s === '1') return 'true';
						if (s === 'false' || s === 'skip' || s === 'none' || s === '0') return 'false';
						return 'auto';
					}
					const noLoginHosts = new Set([
						'google.com', 'www.google.com',
						'bing.com', 'www.bing.com',
						'baidu.com', 'www.baidu.com',
					]);
					const search = (input && input.search) || {};
					const query = asStr((input && input.query) || search.query || '');
					const minResults = Math.max(1, Math.min(100, asNum((input && input.minResults) ?? search.minResults, 10)));
					const loginMode = parseLoginMode((search && search.login) ?? (input && input.login));
					let host = '';
					try {
						const u = new URL(asStr((input && input.url) || ''));
						host = asStr(u.hostname).toLowerCase();
					} catch (_) {}
					const noLoginByHost = noLoginHosts.has(host);
					const needLogin = (loginMode === 'true') ? true : ((loginMode === 'false') ? false : !noLoginByHost);
					return { query, minResults, loginMode, needLogin, host, noLoginByHost };
				}`,
				args: [
					'${{ ({ query: args.query, minResults: args.minResults, search: args.search || {}, url: opts.url || "" }) }}',
				],
			},
			saveAs: 'searchCtx',
			next: { done: 'clear_blockers', failed: 'abort' },
		},
		{
			id: 'clear_blockers',
			desc: '搜索前尝试清理页面阻挡交互的遮罩/弹窗（失败不阻断主流程）',
			action: {
				type: 'invoke',
				target: 'blockers_check_clear',
				args: {
					'blockers.clear': true,
				},
				onError: 'return',
				returnTo: 'caller',
			},
			saveAs: 'blockersOut',
			next: { done: 'route_need_login', failed: 'route_need_login' },
		},
		{
			id: 'route_need_login',
			desc: '根据登录策略决定是否先执行 login.ensure',
			action: {
				type: 'branch',
				cases: [
					{ when: { op: 'truthy', source: 'vars', path: 'searchCtx.needLogin' }, to: 'ensure_login' },
				],
				default: 'focus_search_input',
			},
			next: {},
		},
		{
			id: 'ensure_login',
			desc: '必要时确保已登录',
			action: {
				type: 'invoke',
				target: 'login_check_ensure',
				args: {
					'login.ensure': true,
				},
				onError: 'fail',
				returnTo: 'caller',
			},
			next: { done: 'focus_search_input', failed: 'abort' },
		},
		{
			id: 'focus_search_input',
			desc: '定位并点击页面上的搜索输入框',
			action: {
				type: 'click',
				query: 'search input box',
			},
			next: { done: 'input_query', failed: 'abort' },
		},
		{
			id: 'input_query',
			desc: '在搜索框中输入关键词并提交',
			action: {
				type: 'input',
				text: '${vars.searchCtx.query}',
				mode: 'paste',
				clear: true,
				pressEnter: true,
				preEnterWaitMs: 350,
				postWaitMs: 500,
			},
			next: { done: 'wait_results', failed: 'abort' },
		},
		{
			id: 'wait_results',
			desc: '等待搜索结果列表出现',
			action: {
				type: 'wait',
				by: 'css: #search',
				state: 'present',
				scope: 'current',
				timeoutMs: 10000,
				pollMs: 200,
			},
			next: { done: 'read_results', timeout: 'read_results', failed: 'abort' },
		},
		{
			id: 'read_results',
			desc: '通过 read.list 读取搜索结果列表',
			action: {
				type: 'invoke',
				find: {
					kind: 'rpa',
					must: ['read.list', 'read.action'],
					prefer: ['read.fields', 'read.minItems', 'read.output'],
					filter: filters,
				},
				args: {
					'read.action': 'list',
					'read.minItems': '${vars.searchCtx.minResults}',
					'read.fields': ['url', 'title', 'summary'],
					'read.output': 'json',
					query: '${vars.searchCtx.query}',
				},
				onError: 'fail',
				returnTo: 'caller',
			},
			saveAs: 'searchResult',
			next: { done: 'done', failed: 'abort' },
		},
		{
			id: 'done',
			desc: '返回搜索完成状态',
			action: {
				type: 'done',
				reason: 'search completed',
				conclusion: '${{ ({ ...(vars.searchResult || {}), search: (vars.searchCtx || {}) }) }}',
			},
			next: {},
		},
		{
			id: 'abort',
			desc: '搜索失败，终止流程',
			action: {
				type: 'abort',
				reason: 'search failed',
			},
			next: {},
		},
	],
	vars: {
		searchCtx: { type: 'object', desc: '标准化后的搜索参数与登录策略', from: 'init_search_policy.saveAs' },
		blockersOut: { type: 'object', desc: '搜索前 blocker 清理结果（best-effort）', from: 'clear_blockers.saveAs' },
		searchResult: { type: 'object', desc: 'read.list 返回结果（含 items/nextCursor 等）', from: 'read_results.saveAs' },
	},
};

const searchFlowObject = {
	capabilities,
	filters,
	flow,
};

export default searchFlowObject;
export { capabilities, filters, flow, searchFlowObject };
