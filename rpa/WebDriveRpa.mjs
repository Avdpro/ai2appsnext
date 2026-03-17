import clipboardy from 'clipboardy'
import pathLib from 'path'
import { promises as fsp, promises as fs } from 'fs'
import { ensureCodeLib } from './CodeLib.mjs'
import { URL } from 'url'
import html2md from 'html-to-md'

const codeURL=decodeURIComponent((new URL(import.meta.url)).pathname);
const codeDirURL=pathLib.dirname(codeURL);
const codeDirPath=codeDirURL.startsWith("file://")?pathLib.fileURLToPath(codeDirURL):codeDirURL;

function getWebRpaDataDirRoot(){
	return process.env.WEBRPA_DATADIR || process.env.AAF_DATADIR || "";
}

const aliasPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const WebRpa_Version='0.0.1';

const browserAliasMap=new Map();
const browserMap=new Map();
let nextBrowserId=0;
let nextTempBrowserId=0;
let nextBrowserPort=9222;
let webDriveClassPms=null;
let webDriveAppClassPms=null;
let aiQueryClassPms=null;

async function sleep(time){
	let func,pms;
	pms=new Promise((resolve,reject)=>{
		setTimeout(resolve,time);
	});
	return pms;
}

async function deleteFile(filePath) {
	try {
		await fsp.unlink(filePath);
	} catch (err) {
	}
}

function guessMimeFromExt(filePath) {
	const ext = pathLib.extname(filePath).toLowerCase();
	switch (ext) {
		case ".png": return "image/png";
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".gif": return "image/gif";
		case ".webp": return "image/webp";
		case ".svg": return "image/svg+xml";
		case ".ico": return "image/x-icon";
		case ".bmp": return "image/bmp";
		case ".txt": return "text/plain;charset=utf-8";
		case ".html": return "text/html;charset=utf-8";
		case ".css": return "text/css;charset=utf-8";
		case ".js": return "text/javascript;charset=utf-8";
		case ".json": return "application/json;charset=utf-8";
		case ".pdf": return "application/pdf";
		default: return "application/octet-stream";
	}
}

async function readFileAsDataURL(p, opts = {}) {
	if (!p || typeof p !== "string") {
		throw new TypeError("readFileAsDataURL: path must be a non-empty string");
	}
	const resolvedPath = pathLib.isAbsolute(p) ? p : pathLib.resolve(codeDirPath, p);
	const buf = await fsp.readFile(resolvedPath);
	const mime = (opts.mime && String(opts.mime).trim()) || guessMimeFromExt(resolvedPath);
	const b64 = buf.toString("base64");
	return `data:${mime};base64,${b64}`;
}

async function getWebDriveClass() {
	if(!webDriveClassPms){
		webDriveClassPms=import("./WebDrive.mjs").then((mod)=>{
			return mod.default || mod.WebDrive;
		});
	}
	return await webDriveClassPms;
}

async function getWebDriveAppClass() {
	if(!webDriveAppClassPms){
		webDriveAppClassPms=import("./WebDriveSys.mjs").then((mod)=>{
			return mod.WebDriveApp;
		});
	}
	return await webDriveAppClassPms;
}

async function getAIQueryClass() {
	if(!aiQueryClassPms){
		aiQueryClassPms=import("./aiquery.mjs").then((mod)=>{
			return mod.AIQuery || mod.default;
		});
	}
	return await aiQueryClassPms;
}

function normalizeLaunchMode(mode){
	mode=(mode||"").toString().toLowerCase();
	if(mode==="direct" || mode==="local" || mode==="app"){
		return "direct";
	}
	return "hub";
}

const kPermissionManagedBegin = "// AAWEBRPA_PERMISSION_BEGIN";
const kPermissionManagedEnd = "// AAWEBRPA_PERMISSION_END";
const kPermissionPrefByName = {
	geolocation: "permissions.default.geo",
	notifications: "permissions.default.desktop-notification",
	camera: "permissions.default.camera",
	microphone: "permissions.default.microphone",
};
const kPermissionDescriptorCandidates = {
	geolocation: ["geolocation"],
	notifications: ["notifications", "desktop-notification"],
	camera: ["camera"],
	microphone: ["microphone"],
};
const kPermissionApplyState = {
	granted: "granted",
	allow: "granted",
	allowed: "granted",
	accept: "granted",
	accepted: "granted",
	true: "granted",
	denied: "denied",
	deny: "denied",
	denieded: "denied",
	block: "denied",
	blocked: "denied",
	false: "denied",
	prompt: "prompt",
	ask: "prompt",
	default: "prompt",
};
const kDefaultPermissionNames = Object.keys(kPermissionPrefByName);

function normalizePermissionState(raw, fallback = "denied"){
	const s = String(raw == null ? "" : raw).trim().toLowerCase();
	if(!s){
		return fallback;
	}
	return kPermissionApplyState[s] || fallback;
}

function permissionStateToFirefoxDefaultPref(state){
	// Firefox defaults: 0=ask, 1=allow, 2=block
	if(state === "granted") return 1;
	if(state === "prompt") return 0;
	return 2;
}

function hostMatchesPattern(hostname, pattern){
	const host = String(hostname || "").trim().toLowerCase();
	const raw = String(pattern || "").trim().toLowerCase();
	if(!host || !raw) return false;
	if(raw === "*" || raw === "all") return true;
	if(raw.startsWith("*.")){
		const base = raw.slice(2);
		return host === base || host.endsWith(`.${base}`);
	}
	return host === raw;
}

function parsePermissionRules(raw){
	const out = [];
	const text = String(raw || "").trim();
	if(!text) return out;
	const entries = text.split(";").map((s)=>s.trim()).filter(Boolean);
	for(const entry of entries){
		const i = entry.indexOf(":");
		if(i <= 0) continue;
		const hostPattern = entry.slice(0, i).trim().toLowerCase();
		const body = entry.slice(i + 1).trim();
		if(!hostPattern || !body) continue;
		const permissionStates = {};
		for(const pair of body.split(",").map((s)=>s.trim()).filter(Boolean)){
			const eq = pair.indexOf("=");
			if(eq <= 0) continue;
			const key = pair.slice(0, eq).trim().toLowerCase();
			const val = pair.slice(eq + 1).trim();
			if(!kPermissionPrefByName[key]) continue;
			permissionStates[key] = normalizePermissionState(val, "denied");
		}
		if(Object.keys(permissionStates).length > 0){
			out.push({ hostPattern, permissionStates });
		}
	}
	return out;
}

function parsePermissionPolicy(opts = {}){
	const defaultRaw = opts.permissionDefault ?? process.env.WEBRPA_PERMISSION_DEFAULT;
	const defaultState = normalizePermissionState(defaultRaw, "denied");
	const defaultStates = {};
	for(const name of kDefaultPermissionNames){
		defaultStates[name] = defaultState;
	}
	const envRules = process.env.WEBRPA_PERMISSION_RULES || process.env.WEBRPA_PERMISSION_BY_DOMAIN || "";
	const rules = parsePermissionRules(opts.permissionRules || envRules);
	return { defaultState, defaultStates, rules };
}

async function writePermissionPrefsToProfile(profileDir, policy){
	if(!profileDir) return;
	const lines = [];
	lines.push(kPermissionManagedBegin);
	lines.push(`// generated at ${new Date().toISOString()}`);
	for(const name of kDefaultPermissionNames){
		const prefName = kPermissionPrefByName[name];
		const prefVal = permissionStateToFirefoxDefaultPref(policy.defaultStates[name] || "denied");
		lines.push(`user_pref("${prefName}", ${prefVal});`);
	}
	lines.push(kPermissionManagedEnd);
	const block = `${lines.join("\n")}\n`;
	const userJsPath = pathLib.join(profileDir, "user.js");
	let existing = "";
	try{
		existing = await fsp.readFile(userJsPath, "utf8");
	}catch(_){
		existing = "";
	}
	const begin = existing.indexOf(kPermissionManagedBegin);
	const end = existing.indexOf(kPermissionManagedEnd);
	if(begin >= 0 && end > begin){
		const after = existing.slice(end + kPermissionManagedEnd.length).replace(/^\s*\n?/, "");
		existing = `${existing.slice(0, begin).trimEnd()}\n${after}`;
	}
	const finalText = `${existing.trimEnd()}\n${block}`;
	await fsp.writeFile(userJsPath, finalText, "utf8");
}

function findPermissionRuleForHost(policy, hostname){
	if(!policy || !Array.isArray(policy.rules) || !hostname) return null;
	for(const rule of policy.rules){
		if(hostMatchesPattern(hostname, rule.hostPattern)){
			return rule;
		}
	}
	return null;
}

async function applyDomainPermissionRule(browser, urlStr, policy){
	if(!browser || typeof browser.setPermission !== "function") return;
	if(!policy || !Array.isArray(policy.rules) || policy.rules.length === 0) return;
	let url;
	try{
		url = new URL(String(urlStr || ""));
	}catch(_){
		return;
	}
	const rule = findPermissionRuleForHost(policy, url.hostname);
	if(!rule) return;
	if(!browser._aaPermissionApplied){
		browser._aaPermissionApplied = new Set();
	}
	const origin = url.origin;
	for(const [logicalName, state] of Object.entries(rule.permissionStates || {})){
		const stateNorm = normalizePermissionState(state, policy.defaultState || "denied");
		const dedupeKey = `${origin}|${logicalName}|${stateNorm}`;
		if(browser._aaPermissionApplied.has(dedupeKey)) continue;
		const candidates = kPermissionDescriptorCandidates[logicalName] || [logicalName];
		let applied = false;
		for(const candidate of candidates){
			try{
				await browser.setPermission({
					name: candidate,
					state: stateNorm,
					origin,
					userContext: "default",
				});
				applied = true;
				break;
			}catch(_){
			}
		}
		if(applied){
			browser._aaPermissionApplied.add(dedupeKey);
		}
	}
}


function getBrowserId(browser){
	let keys,key;
	keys=Array.from(browserMap.keys());
	for(key of keys){
		if(browserMap.get(key)===browser){
			return key;
		}
	}
	return null;
}

let WebDriveRpaStarted=false;
/**
 * 清理指定目录中以指定前缀开头的所有子目录
 * @param {string} prefix - 前缀（如 'firefox-profile-'）
 * @param {string} [baseDir='/tmp'] - 扫描的根目录，默认 /tmp
 */
async function cleanTmpDirs(prefix, baseDir = '/tmp') {
	try {
		const entries = await fs.readdir(baseDir, { withFileTypes: true });
		
		const targets = entries.filter(entry =>
			entry.isDirectory() && entry.name.startsWith(prefix)
		);
		
		for (const dir of targets) {
			const fullPath = pathLib.join(baseDir, dir.name);
			try {
				await fs.rm(fullPath, { recursive: true, force: true });
				console.log(`✅ 已删除: ${fullPath}`);
			} catch (err) {
				console.warn(`⚠️ 删除失败: ${fullPath}`, err.message);
			}
		}
		
		console.log(`共尝试清理 ${targets.length} 个目录`);
	} catch (err) {
		console.error('读取目录失败：', err.message);
	}
}

async function openBrowser(session,alias,opts){
	let agentNode, browser, browserId,dirPath,sysId,res,launchMode,WebDrive,WebDriveApp,port,permissionPolicy;
	opts=opts||{};
	permissionPolicy=parsePermissionPolicy(opts);
	
	agentNode=session?.agentNode||null;
	launchMode=normalizeLaunchMode(opts.launchMode||opts.webDriveMode||session?.options?.webDriveMode||process.env.WEBRPA_WEBDRIVE_MODE);
	if(alias){
		if((!aliasPattern.test(alias)) || alias.startsWith("TMP_")){
			throw Error("Browser alias is invalid.");
		}
		browserId=browserAliasMap.get(alias);
		if(browserId){
			browser=browserMap.get(browserId);
			if(!browser.connected){
				browserMap.delete(browserId);
				browser=null;
			}
			if(browser){
				return browser;
			}
		}
	}

	browserId = "" + (nextBrowserId++);
	if(launchMode==="direct"){
		WebDriveApp=await getWebDriveAppClass();
		browser = new WebDriveApp(browserId);
	}else{
		if(!session || !session.callHub){
			throw Error("Hub launch mode requires session.callHub.");
		}
		WebDrive=await getWebDriveClass();
		browser = new WebDrive();
	}
	browser.aaeBrowserId=browserId;
	browser.aaeLaunchMode=launchMode;
	browserMap.set(browserId, browser);
	
	if(alias){
		browserAliasMap.set(alias,browserId);
		browser.aaeeAlias=alias;
	}else{
		alias="TMP_"+(nextTempBrowserId++);
		browserAliasMap.set(alias,browserId);
		browser.aaeeAlias=alias;
	}
	
	browser.on("browser.exit",()=>{
		browserAliasMap.delete(alias);
		browserMap.delete(browserId);
	});
	browser.on("browser.willExit",()=>{
		browserAliasMap.delete(alias);
		browserMap.delete(browserId);
	});
	
	if(launchMode==="direct"){
		dirPath=opts.userDataDir;
		const dataDirRoot = getWebRpaDataDirRoot();
		if(!dirPath && alias && dataDirRoot){
			dirPath=dataDirRoot;
			if(dirPath[0]!=="/"){
				throw Error("WEBRPA_DATADIR must be absolute path.");
			}
			dirPath = pathLib.join(dirPath, alias);
			try{
				await fs.access(dirPath);
			}catch(_){
				try{
					await fs.mkdir(dirPath,{recursive:true});
				}catch(_){
					dirPath=null;
				}
			}
		}
		if(!dirPath){
			dirPath = await fsp.mkdtemp(pathLib.join("/tmp/","AaWebDrive-"));
		}
		opts.userDataDir=dirPath;
		await writePermissionPrefsToProfile(dirPath, permissionPolicy);
		if(opts.userDataDir){
			let zonePath=pathLib.join(opts.userDataDir,"AAEZone");
			try{
				await fs.access(zonePath);
				browser.aaeZonePath=zonePath;
			}catch(_){
				try {
					await fs.mkdir(zonePath, { recursive: true });
					browser.aaeZonePath=zonePath;
				}catch(_){
				}
			}
		}
		port=opts.port||opts.debugPort||process.env.BROWSER_DEBUG_PORT||nextBrowserPort++;
		await browser.start(opts.pathToFireFox||opts.firefoxAppPath||null,dirPath,port,alias);
		if(permissionPolicy.rules.length > 0){
			const applyOnNav = async (params)=>{
				try{
					await applyDomainPermissionRule(browser, params?.url || "", permissionPolicy);
				}catch(_){
				}
			};
			browser.on("browsingContext.navigationCommitted", applyOnNav);
			browser.on("browsingContext.historyUpdated", applyOnNav);
		}
	}else{
		sysId=await session.callHub("WebDriveOpenBrowser",{alias:alias,options:opts});
		await browser.start(sysId,alias,agentNode);
	}
	return browser;
}

let aaLogoIcon=null;
let aaLogoIconLoadTried=false;

async function getDefaultInPageIcon(){
	if(aaLogoIconLoadTried){
		return aaLogoIcon||null;
	}
	aaLogoIconLoadTried=true;
	try{
		aaLogoIcon=await readFileAsDataURL(pathLib.join(codeDirPath,"ai2apps.svg"));
	}catch(_){
		aaLogoIcon=null;
	}
	return aaLogoIcon||null;
}

//***************************************************************************
//WebRpa:
//***************************************************************************
let WebRpa,webRpa;
WebRpa=function(session,opts){
	this.session=session;
	this.agentNode=session?.agentNode||null;
	this.version=WebRpa_Version;
	this.aiQuery=null;
	this.options=opts||{};
	
	this.browser=null;
	this.allowMultiBrowsers=!!this.options.allowMultiBrowsers;
	this.autoCurrentPage=this.options.autoCurrentPage!==false;
	// Default false for backward compatibility:
	// only track tabs/pages that are related to existing session pages.
	// When true, include all newly opened top-level tabs into sessionPages.
	this.includeAllNewTabs=!!this.options.includeAllNewTabs;
	this.sessionPages=[];
	this.currentPage=null;
	
	//We only need set this once:
	if(this.agentNode && !this.agentNode.WSMsg_WebDriveBrowserClosed){
		//-------------------------------------------------------------------
		this.agentNode.WSMsg_WebDriveBrowserClosed=async function(msgVO){
			let alias,browserId,browser;
			alias=msgVO.alias;
			browserId=browserAliasMap.get(alias);
			if(browserId) {
				browser = browserMap.get(browserId);
				if(browser){
					browser.emit("browser.exit");
				}
			}
		};
		//-------------------------------------------------------------------
		this.agentNode.WSMsg_WebDriveEvent=async function(msgVO){
			let alias,browserId,browser,event;
			alias=msgVO.alias;
			event=msgVO.event;
			browserId=browserAliasMap.get(alias);
			if(browserId && event) {
				browser = browserMap.get(browserId);
				if(browser){
					try {
						browser.handleEvent(event);
					}catch(_){
					}
				}
			}
		};
	}
}
webRpa=WebRpa.prototype={};
WebRpa.version=WebRpa_Version;

WebRpa.getPageByRef=function(ref){
	let browserId,browser,page;
	browserId=ref.browserId;
	if(browserId){
		browser=browserMap.get(browserId);
		if(!browser){
			return null;
		}
		return browser.pageMap.get(ref.contextId);
	}else{
		let browsers=Array.from(browserMap.values());
		for(browser of browsers){
			page=browser.pageMap.get(ref.contextId);
			if(page){
				return page;
			}
		}
	}
	return null;
};

//------------------------------------------------------------------------
//TODO: Port this:
webRpa.setupAIQuery=async function(context,agentPath,agentJaxId){
	let AIQuery=await getAIQueryClass();
	let aiQuery=this.aiQuery=new AIQuery(this,context,agentPath,agentJaxId);
	await aiQuery.setup();
};//TODO: Port this:

//---------------------------------------------------------------------------
//TODO: Port this:
webRpa.listBrowserAndPages=async function(){
	let browsers, browserId, browser,list,stub,pages,page,url,title;
	browsers=browserAliasMap.values();
	list=[];
	for(browserId of browsers){
		browser=browserMap.get(browserId);
		stub={browser:browser,id:browserId,alias:browser.aaeeAlias};
		pages=await browser.getBrowsingContextTree(0);
		stub.pages=[];
		for(page of pages){
			url=await page.url();
			title=await page.title();
			stub.pages.push({page:page,url:url,title:title});
		}
		list.push(stub);
	}
	return list;
};//TODO: Port this:

//---------------------------------------------------------------------------
webRpa.getPageByContextId=function(context){
	let page;
	for(page of this.sessionPages){
		if(page.context===context){
			return page;
		}
	}
	return null;
};

//---------------------------------------------------------------------------
webRpa.openBrowser=async function(alias,opts){
	let self=this;
	let browser=await openBrowser(this.session,alias,opts);
	if(this.browser && browser!==this.browser && !this.allowMultiBrowsers){
		throw Error("WebRpa.openBrowser ERROR: webRpa already binded with browser.");
	}
	if(browser){
		browser.aaeRefcount=browser.aaeRefcount?browser.aaeRefcount+1:1;
	}
	browser.aaWebRpa=this;
	if(!this.browser) {
		this.browser = browser;
	}
	
	let waitFunc=async (message)=>{
		let pages,context,call,page;
		let parent,opener;
		context=message.context;
		
		if(this.getPageByContextId(context)){
			//Already in pages, do nothing...
			return;
		}
		if(
			this.includeAllNewTabs
			|| this.getPageByContextId(message.parent)
			|| this.getPageByContextId(message.originalOpener)
		){
			pages = await browser.getPages();
			page = pages.find((page) => {return page.context === context});
			if(page){
				this.sessionPages.push(page);
				if(!this.currentPage || this.autoCurrentPage){
					this.currentPage=page;
				}
			}
		}
	}
	this.traceOpen=waitFunc;
	browser.on("browsingContext.contextCreated",waitFunc);

	waitFunc=(message)=>{
		let context,page,pages,i,n;
		context=message.context;
		pages=this.sessionPages;
		n=pages.length;
		for(i=0;i<n;i++){
			page=pages[i];
			if(page.context===context){
				pages.splice(i,1);
				if(page===this.currentPage){
					this.currentPage=pages[pages.length-1]||null;
				}
				break;
			}
		}
	};
	this.traceClose=waitFunc;
	browser.on("browsingContext.contextDestroyed",waitFunc);
	return browser;
};

//---------------------------------------------------------------------------
webRpa.closeBrowser=async function(browser){
	if(browser!==this.browser){
		return;
	}
	if(browser.aaeLaunchMode==="direct"){
		await browser.close();
		return;
	}
	if(!this.agentNode || !this.agentNode.callHub){
		throw Error("closeBrowser requires agentNode.callHub in hub mode.");
	}
	await this.agentNode.callHub("WebDriveCloseBrowser",{alias:browser.alias});
}

//---------------------------------------------------------------------------
webRpa.getPageByTitle=async function(browser,title){
	let page,pages;
	pages=await browser.getPages();
	for(page of pages){
		if((await page.title())===title){
			return page;
		}
	}
	return null;
};

//---------------------------------------------------------------------------
webRpa.openPage=async function(browser){
	let page;
	page = await browser.newPage();
	if(!this.getPageByContextId(page.context)) {
		this.sessionPages.push(page)
		if (!this.currentPage || this.autoCurrentPage) {
			this.currentPage=page;
		}
	}
	return page;
};

//---------------------------------------------------------------------------
webRpa.closePage=async function(page){
	await page.close();
};

//---------------------------------------------------------------------------
// Create a lightweight worker WebRpa that shares browser connection,
// but owns an isolated page lifecycle.
webRpa.fork=async function(opts){
	let worker,browser,page,url,wait,sourcePage;
	opts=opts||{};
	browser=this.browser;
	if(!browser){
		throw Error("WebRpa.fork ERROR: no active browser.");
	}
	const isolation=String(opts.isolation||"tab").toLowerCase();
	if(isolation!=="tab"){
		throw Error("WebRpa.fork ERROR: only isolation='tab' is supported now.");
	}
	worker=new WebRpa(this.session,Object.assign({},this.options,opts));
	worker.browser=browser;
	worker.parentWebRpa=this;
	worker.isForkWorker=true;
	worker.autoCurrentPage=true;
	worker.allowMultiBrowsers=true;
	if(opts.currentPage===true){
		sourcePage=this.currentPage||null;
		if(!sourcePage){
			throw Error("WebRpa.fork ERROR: currentPage is required when opts.currentPage=true.");
		}
		worker.borrowedCurrentPage=true;
		worker.borrowedPage=sourcePage;
		worker.sessionPages=[sourcePage];
		worker.currentPage=sourcePage;
	}else{
		page=await worker.openPage(browser);
	}
	url=opts.url||"";
	if(url){
		wait=opts.wait||"complete";
		page=worker.currentPage||page;
		await page.goto(url,{wait});
	}
	return worker;
};

//---------------------------------------------------------------------------
webRpa.disposeFork=webRpa.closeFork=async function(opts){
	let page,pages,keepBorrowed;
	opts=opts||{};
	keepBorrowed=(opts.keepBorrowedPage!==false);
	pages=Array.isArray(this.sessionPages)?Array.from(this.sessionPages):[];
	for(page of pages){
		if(keepBorrowed && this.borrowedCurrentPage===true && page===this.borrowedPage){
			continue;
		}
		try{
			await this.closePage(page);
		}catch(_){
		}
	}
	this.sessionPages.length=0;
	this.currentPage=null;
	this.borrowedCurrentPage=false;
	this.borrowedPage=null;
	return true;
};

//---------------------------------------------------------------------------
webRpa.withFork=async function(opts,fn){
	let worker,ret;
	if(typeof opts==="function" && fn===undefined){
		fn=opts;
		opts={};
	}
	if(typeof fn!=="function"){
		throw Error("WebRpa.withFork ERROR: callback function is required.");
	}
	worker=await this.fork(opts||{});
	try{
		ret=await fn(worker);
	}finally{
		await worker.disposeFork();
	}
	return ret;
};

//---------------------------------------------------------------------------
webRpa.setCurrentPage=function(page){
	let idx;
	idx=this.sessionPages.indexOf(page);
	if(idx<0){
		this.sessionPages.push(page);
	}
	this.currentPage=page;
	return page;
}

//---------------------------------------------------------------------------
webRpa.saveFile=async function(browser,fileName,data){
	let zonePath;
	zonePath=browser.aaeZonePath;
	if(!zonePath){
		return false;
	}
	await fsp.writeFile(zonePath+"/"+fileName, data);
	return true;
};

//---------------------------------------------------------------------------
webRpa.deleteFile=async function(browser,fileName){
	let zonePath;
	zonePath=browser.aaeZonePath;
	if(!zonePath){
		return false;
	}
	await deleteFile(zonePath+"/"+fileName);
	return true;
};

//---------------------------------------------------------------------------
webRpa.ensureCodeLib=webRpa.getCodeTag=async function(page){
	return await ensureCodeLib(page);
};

//---------------------------------------------------------------------------
webRpa.waitForDownloadBegin=async function(page,opts){
	page=page||this.currentPage;
	if(!page){
		throw Error("WebRpa.waitForDownloadBegin ERROR: no active page.");
	}
	return await page.waitForDownloadBegin(opts||{});
};

//---------------------------------------------------------------------------
webRpa.waitForDownloadEnd=async function(page,opts){
	page=page||this.currentPage;
	if(!page){
		throw Error("WebRpa.waitForDownloadEnd ERROR: no active page.");
	}
	return await page.waitForDownloadEnd(opts||{});
};

//---------------------------------------------------------------------------
webRpa.triggerDownload=async function(page,opts){
	let url,selector,query,node,newTab;
	page=page||this.currentPage;
	if(!page){
		throw Error("WebRpa.triggerDownload ERROR: no active page.");
	}
	opts=opts||{};
	url=opts.url||"";
	if(url){
		newTab=!!opts.newTab;
		return await page.callFunction((url,newTab)=>{
			let a;
			if(!url){
				return false;
			}
			a=document.createElement("a");
			a.href=String(url);
			a.rel="noopener noreferrer";
			if(newTab){
				a.target="_blank";
			}
			document.body.appendChild(a);
			a.click();
			setTimeout(()=>{
				try{a.remove();}catch(_){}
			},0);
			return true;
		},[url,newTab],{awaitPromise:true});
	}
	selector=opts.selector||"";
	query=opts.query||"";
	node=opts.node||null;
	if(selector || query || node){
		return await this.userAction(page,{
			action:"click",
			selector:selector||null,
			query:query||null,
			node:node||null,
			smooth:opts.smooth,
			offset:opts.offset,
		});
	}
	throw Error("WebRpa.triggerDownload ERROR: missing url/selector/query/node.");
};

//---------------------------------------------------------------------------
webRpa.download=async function(page,opts){
	let beginTimeout,endTimeout,waitForEnd,matchContext;
	let beginP,endP,beginRet,endRet,triggerError;
	page=page||this.currentPage;
	if(!page){
		throw Error("WebRpa.download ERROR: no active page.");
	}
	opts=opts||{};
	beginTimeout=Number(opts.beginTimeout??opts.timeout);
	if(!(beginTimeout>0)){
		beginTimeout=15000;
	}
	endTimeout=Number(opts.endTimeout??opts.timeout);
	if(!(endTimeout>0)){
		endTimeout=60000;
	}
	waitForEnd=opts.waitForEnd!==false;
	matchContext=opts.matchContext===true;

	beginP=page.waitForDownloadBegin({timeout:beginTimeout,matchContext});
	endP=waitForEnd?page.waitForDownloadEnd({timeout:endTimeout,matchContext}):null;
	triggerError=null;
	try{
		await this.triggerDownload(page,opts);
	}catch(err){
		triggerError=err;
	}

	beginRet=await beginP;
	endRet=waitForEnd?await endP:null;

	if(triggerError && !beginRet){
		throw triggerError;
	}
	return {
		ok:waitForEnd?!!endRet:!!beginRet,
		started:!!beginRet,
		finished:waitForEnd?!!endRet:null,
		begin:beginRet||null,
		end:endRet||null,
		triggerError:triggerError?String(triggerError.message||triggerError):"",
	};
};

//***************************************************************************
//Access DOM-Tree:
//***************************************************************************
{
	//-----------------------------------------------------------------------
	WebRpa.getNodeAttribute=WebRpa.getNodeAttr=
	webRpa.getNodeAttribute = webRpa.getNodeAttr = async function (pageFrame, node, key) {
		let codeTag;
		codeTag = await ensureCodeLib(pageFrame);
		return await pageFrame.callFunction((codeTag, node, key) => {
			let codeLib = globalThis[codeTag];
			return codeLib.getNodeAttribute(node, key);
		}, [codeTag, node, key]);
	};
	
	//-----------------------------------------------------------------------
	WebRpa.setNodeAttribute=WebRpa.setNodeAttr=
	webRpa.setNodeAttribute=webRpa.setNodeAttr=async function(pageFrame,node,key,value){
		let codeTag;
		codeTag=await ensureCodeLib(pageFrame);
		return await pageFrame.callFunction((codeTag,node,key,value)=>{
			let codeLib=globalThis[codeTag];
			return codeLib.setNodeAttribute(node,key,value);
		},[codeTag,node,key,value]);
	};

	//-----------------------------------------------------------------------
	WebRpa.getNodeAttributes=WebRpa.getNodeAttrs=
	webRpa.getNodeAttributes=webRpa.getNodeAttrs=async function(pageFrame,node){
		let codeTag;
		codeTag=await ensureCodeLib(pageFrame);
		return await pageFrame.callFunction((codeTag,node)=>{
			let codeLib=globalThis[codeTag];
			return codeLib.getNodeAttributes(node);
		},[codeTag,node]);
	};

	//-----------------------------------------------------------------------
	WebRpa.getNodeParent=
	webRpa.getNodeParent=async function(pageFrame,node){
		let codeTag;
		codeTag=await ensureCodeLib(pageFrame);
		return await pageFrame.callFunction((codeTag,node)=>{
			let codeLib=globalThis[codeTag];
			return codeLib.getNodeParent(node);
		},[codeTag,node]);
	};

	//-----------------------------------------------------------------------
	WebRpa.getNodeChildren=
	webRpa.getNodeChildren=async function(pageFrame,node){
		let codeTag;
		codeTag=await ensureCodeLib(pageFrame);
		return await pageFrame.callFunction((codeTag,node)=>{
			let codeLib=globalThis[codeTag];
			return codeLib.getNodeChildren(node);
		},[codeTag,node]);
	};

	//-----------------------------------------------------------------------
	WebRpa.readNodeView=
	webRpa.readNodeView=async function(pageFrame,node,opts){
		let codeTag;
		codeTag=await ensureCodeLib(pageFrame);
		return await pageFrame.callFunction((codeTag,node,opts)=>{
			let codeLib=globalThis[codeTag];
			return codeLib.readNodeView(node,opts);
		},[codeTag,node,opts]);
	};
	
	//-----------------------------------------------------------------------
	WebRpa.readNodeText=
	webRpa.readNodeText=async function(pageFrame,node,opts){
		let codeTag;
		codeTag=await ensureCodeLib(pageFrame);
		return await pageFrame.callFunction((codeTag,node,opts)=>{
			let codeLib=globalThis[codeTag];
			return codeLib.readNodeText(node,opts);
		},[codeTag,node,opts]);
	};

	//-----------------------------------------------------------------------
	WebRpa.readNodeHTML=WebRpa.readInnerHTML=
	webRpa.readNodeHTML=webRpa.readInnerHTML=async function(pageFrame,node,opts){
		let codeTag;
		opts=opts||{mark:true,clean:true};
		codeTag=await ensureCodeLib(pageFrame);
		return await pageFrame.callFunction((codeTag,node,opts) => {
			let codeLib = globalThis[codeTag];
			return codeLib.snapNodeHTML(node, opts);
		}, [codeTag,node,opts]);
	};
	
	//-----------------------------------------------------------------------
	WebRpa.getInnerHTML=
	webRpa.getInnerHTML=async function(pageFrame,node){
			let codeTag;
			codeTag=await ensureCodeLib(pageFrame);
			return await pageFrame.callFunction((codeTag,node) => {
				let codeLib = globalThis[codeTag];
				return codeLib.getInnerHTML(node);
			}, [codeTag,node]);
		};

	//-----------------------------------------------------------------------
	WebRpa.readArticle=
	webRpa.readArticle=async function(pageFrame,baseNode,options){
		let html,md;
		if(baseNode) {
			html = await this.readInnerHTML(pageFrame, baseNode, options);
			md = html2md(html);
			return md;
		}
		try{
			return await pageFrame.readArticle();
		}catch(error){
			// Fallback for environments where Readability helper is missing/broken.
			html = await this.readInnerHTML(pageFrame, null, options||{removeHidden:false});
			md = html2md(html);
			return md;
		}
	};
}

//***************************************************************************
//Query/find content:
//***************************************************************************
{
	//-----------------------------------------------------------------------
	//TODO: Maybe use default $() to get node.
	WebRpa.queryNode=
	webRpa.queryNode=async function(pageFrame,node,selector,opts){
		let codeTag,result;
		codeTag=await ensureCodeLib(pageFrame);
		result=await pageFrame.callFunction((codeTag,node,selector,opts)=>{
			let codeLib=globalThis[codeTag];
			return codeLib.queryNode(node,selector,opts);
		},[codeTag,node,selector,opts]);
		return result;
	};
	
	//-----------------------------------------------------------------------
	webRpa.queryNodeInPages=async function(pageFrame,node,selector,scope,opts){
		let codeTag,result,pages,i,n,find,page,resultPage;
		if(pageFrame){
			if(Array.isArray(pageFrame)){
				pages=pageFrame;
			}else {
				pages = [pageFrame];
			}
		}else{
			switch(scope){
				case "newest":{
					pages=[this.sessionPages[this.sessionPages.length-1]];
					break;
				}
				case "any":{
					pages=this.sessionPages;
					break;
				}
				default:{
					pages=[this.currentPage];
					break;
				}
			}
		}
		n=pages.length;
		result=null;
		resultPage=null;
		for(i=0;i<n;i++){
			page=pages[i];
			codeTag=await ensureCodeLib(page);
			find=await page.callFunction((codeTag,node,selector,opts)=>{
				let codeLib=globalThis[codeTag];
				return codeLib.queryNode(node,selector,opts);
			},[codeTag,node,selector,opts]);
			if(find){
				resultPage=page;
				result=find;
				if(page===this.currentPage){
					break;
				}
			}
		}
		if(result) {
			return { page: resultPage, node: result };
		}
		return null;
	};
	
	//-----------------------------------------------------------------------
	//TODO: Maybe use default $$() to get node
	WebRpa.queryNodes=
	webRpa.queryNodes=async function(pageFrame,node,selector,opts){
		let codeTag,result;
		codeTag=await ensureCodeLib(pageFrame);
		result=await pageFrame.callFunction((codeTag,node,selector,opts)=>{
			let codeLib=globalThis[codeTag];
			return codeLib.queryNodes(node,selector,opts);
		},[codeTag,node,selector,opts]);
		return result;
	};
	
	//-----------------------------------------------------------------------
	webRpa.queryNodesInPages=async function(pageFrame,node,selector,scope,opts){
		let codeTag,result,pages,i,n,find,page,resultPage;
		if(pageFrame){
			if(Array.isArray(pageFrame)){
				pages=pageFrame;
			}else {
				pages = [pageFrame];
			}
		}else{
			switch(scope){
				case "newest":{
					pages=[this.sessionPages[this.sessionPages.length-1]];
					break;
				}
				case "any":{
					pages=this.sessionPages;
					break;
				}
				default:{
					pages=[this.currentPage];
					break;
				}
			}
		}
		n=pages.length;
		result=null;
		resultPage=null;
		for(i=0;i<n;i++){
			page=pages[i];
			codeTag=await ensureCodeLib(page);
			find=await page.callFunction((codeTag,node,selector,opts)=>{
				let codeLib=globalThis[codeTag];
				return codeLib.queryNodes(node,selector,opts);
			},[codeTag,node,selector,opts]);
			if(find && find.length>0){
				resultPage=page;
				result=find;
				if(page===this.currentPage){
					break;
				}
			}
		}
		if(result) {
			return { page: resultPage, nodes: result };
		}
		return null;
	};
	
	//-----------------------------------------------------------------------
	//TODO: Maybe use default $() to get node.
	webRpa.waitQuery=async function(pageFrame,selector,opts){
		let codeTag,startTime,node,timeout;
		timeout=opts.timeout||0;
		node=opts.aaeId||opts.AAEId||opts.root;
		startTime=Date.now();
		codeTag=await ensureCodeLib(pageFrame);
		do{
			try {
				node=await pageFrame.callFunction((codeTag,node,selector,opts)=>{
					let codeLib=globalThis[codeTag];
					return codeLib.queryNode(node,selector,opts);
				},[codeTag,node,selector,opts]);
				if(node){
					return node;
				}
				await sleep(200);
				if(timeout>0 && Date.now()-startTime>timeout){
					return null;
				}
			} catch(e) {
				console.log(`[WebDriveRpa.waitQuery] Exception: ${e.message}, codeTag: ${codeTag}, selector: ${selector}`);
				throw e;
			}
		}while(1);
	}
	
	//-----------------------------------------------------------------------
	webRpa.waitQueryInPages=async function(pageFrame,selector,scope,opts){
		let codeTag,startTime,node,timeout,pages,i,n,find,page,result,resultPage;
		timeout=opts.timeout||0;
		node=opts.aaeId||opts.AAEId||opts.root;
		startTime=Date.now();
		if(pageFrame){
			if(Array.isArray(pageFrame)){
				pages=pageFrame;
			}else {
				pages = [pageFrame];
			}
		}else{
			switch(scope){
				case "newest":{
					pages=[this.sessionPages[this.sessionPages.length-1]];
					break;
				}
				case "any":{
					pages=this.sessionPages;
					break;
				}
				default:{
					pages=[this.currentPage];
					break;
				}
			}
		}
		codeTag=await ensureCodeLib(pageFrame);
		FindNode:{
			do {
				result=null;
				resultPage=null;
				n = pages.length;
				for (i = 0; i < n; i++) {
					page=pages[i];
					codeTag = await ensureCodeLib(page);
					node = await page.callFunction((codeTag, node, selector, opts) => {
						let codeLib = globalThis[codeTag];
						return codeLib.queryNode(node, selector, opts);
					}, [codeTag, node, selector, opts]);
					if (node) {
						result=node;
						resultPage=page;
						if(page===this.currentPage){
							break FindNode;
						}
					}
					
				}
				if(result){
					break FindNode;
				}
				await sleep(200);
				if(timeout>0 && Date.now()-startTime>timeout){
					return null;
				}
			} while (1);
		}
		if(result){
			return {page:resultPage,node:result};
		}
		return null;
	}
}

//***************************************************************************
//User actions:
//***************************************************************************
{
	//-----------------------------------------------------------------------
	async function moveMouseTo(page,x,y,smooth=false){
		await page.moveMouse(x,y,{smooth:smooth});
	}

	//-----------------------------------------------------------------------
	async function clickMouse(page){
		await page.mouseClick();
	}

	//-----------------------------------------------------------------------
	webRpa.userAction=async function(pageFrame,opts){
		let action,query,codeTag;
		action=opts.action;
		query=opts.query;
		switch(action){
			case "click": {
				let root,node,dx,dy,selector,offset;
				root=opts.root||null;
				node=opts.node||null;
				selector=opts.query||opts.selector;
				if(selector && !root) {
					await pageFrame.click(selector,opts);
				}else {
					if(!node) {
						if (root && selector) {
							codeTag = await ensureCodeLib(pageFrame);
							node = await pageFrame.callFunction((codeTag, root, selector, opts) => {
								let codeLib = globalThis[codeTag];
								return codeLib.queryNode(root, selector, opts);
							}, [codeTag, root, selector, {}]);
						}
					}
					if (node) {
						let rect = node.rect;
						if(!rect && node.handle) {
							rect=await this.callFunction((item)=>{
								const rect=item.getBoundingClientRect();
								if(!rect){
									return null;
								}
								return {
									x:rect.x, y:rect.y, width:rect.width, height: rect.height
								};
							},[node.handle]);
						}
						if(rect) {
							let tgtX, tgtY;
							if (opts.offset) {
								tgtX = Math.round(rect.x + opts.offset.x);
								tgtY = Math.round(rect.y + opts.offset.y);
							} else {
								tgtX = Math.round(rect.x + rect.width * 0.5);
								tgtY = Math.round(rect.y + rect.height * 0.5);
							}
							await moveMouseTo(pageFrame, tgtX, tgtY, opts.smooth);
							await clickMouse(pageFrame);
						}
					}
				}
				break;
			}
			case "type":{
				let node,content;
				content=opts.content;
				await pageFrame.type(opts.selector||opts.query||null, content);
				break;
			}
			case "paste": {
				let node,content;
				content=opts.content;
				await clipboardy.write('Hello async clipboard!');
				if(!content){
					content=await clipboardy.read();
				}
				await pageFrame.type(opts.selector||opts.query||null, content);
				break;
			}
		}
	};
	
}

//***************************************************************************
//In-Page UI and dialogs
//***************************************************************************
{
	function copyOptsWithoutPersist(input){
		const out={...(input||{})};
		delete out.persistAcrossNav;
		delete out.persistKey;
		delete out.persistTtlMs;
		delete out.reopenDelayMs;
		delete out.pollMs;
		return out;
	}

	function makeTipTrackerKey(page, opts = {}, tipId = "") {
		const ctx = String(page?.context || "page");
		const pk = String(opts.persistKey || "").trim();
		const id = String(tipId || opts.id || "").trim();
		return `${ctx}::${pk || id || "__anon__"}`;
	}

	async function safePageUrl(page){
		try{
			return await page.url();
		}catch(_){
			return "";
		}
	}

	function isNavigationLikeError(err){
		const s=String(err?.message||err||"").toLowerCase();
		if(!s) return false;
		return /navigation|context|realm|connection closed|discarded|detached|no such/.test(s);
	}

	async function inPageTipExists(page, tipId){
		if(!tipId) return false;
		try{
			const found=await page.callFunction(function(id){
				try{
					const rid="__ai2apps_tip_root__";
					const root=document.getElementById(rid);
					if(!root) return false;
					const esc=(s)=>{
						try{
							return (window.CSS&&typeof CSS.escape==="function") ? CSS.escape(s) : String(s).replace(/["\\]/g,"\\$&");
						}catch(_){
							return String(s).replace(/["\\]/g,"\\$&");
						}
					};
					const sid=String(id||"");
					if(!sid) return false;
					const node=root.querySelector(`[data-ai2apps-tip='1'][data-ai2apps-tip-id="${esc(sid)}"]`);
					return !!node;
				}catch(_){
					return false;
				}
			},[tipId],{awaitPromise:true});
			return !!found;
		}catch(_){
			return false;
		}
	}

	async function inPageTipOnce(page,text,opts){
		return await page.callFunction((await import("./InPageUI.mjs")).inPageTip,[text,opts]);
	}

	async function inPagePromptOnce(page,text,opts){
		return await page.callFunction((await import("./InPageUI.mjs")).inPagePrompt,[text,opts]);
	}

	function clearTipTrackersByPredicate(self,pred){
		if(!self._inPageTipTrackers) self._inPageTipTrackers=new Map();
		const keys=Array.from(self._inPageTipTrackers.keys());
		for(const k of keys){
			const t=self._inPageTipTrackers.get(k);
			if(!t) continue;
			if(!pred(t,k)) continue;
			t.stopped=true;
			if(t.timer) clearInterval(t.timer);
			self._inPageTipTrackers.delete(k);
		}
	}

	//-----------------------------------------------------------------------
	webRpa.inPagePrompt=async function(page,text,opts={}){
		opts=opts||{};
		if(opts.icon===undefined){
			opts.icon=await getDefaultInPageIcon();
		}
		const persistAcrossNav=!!opts.persistAcrossNav;
		if(!persistAcrossNav){
			return await inPagePromptOnce(page,text,opts);
		}

		const startedAt=Date.now();
		const ttlRaw=Number(opts.persistTtlMs ?? 60000);
		const ttlMs=Number.isFinite(ttlRaw) ? Math.max(0,ttlRaw) : 60000;
		const reopenDelayRaw=Number(opts.reopenDelayMs ?? 180);
		const reopenDelayMs=Number.isFinite(reopenDelayRaw) ? Math.max(50,reopenDelayRaw) : 180;
		const callOpts=copyOptsWithoutPersist(opts);

		while(true){
			const beforeUrl=await safePageUrl(page);
			try{
				const result=await inPagePromptOnce(page,text,callOpts);
				const afterUrl=await safePageUrl(page);
				const navChanged=!!beforeUrl && !!afterUrl && beforeUrl!==afterUrl;
				const disappearedLike=(result===null || result===false || (result && typeof result==="object" && result.ok===false));
				const expired=(ttlMs>0) && ((Date.now()-startedAt)>=ttlMs);
				if(disappearedLike && navChanged && !expired){
					await sleep(reopenDelayMs);
					continue;
				}
				return result;
			}catch(err){
				const afterUrl=await safePageUrl(page);
				const navChanged=!!beforeUrl && !!afterUrl && beforeUrl!==afterUrl;
				const expired=(ttlMs>0) && ((Date.now()-startedAt)>=ttlMs);
				if((navChanged || isNavigationLikeError(err)) && !expired){
					await sleep(reopenDelayMs);
					continue;
				}
				throw err;
			}
		}
	};
	
	//-----------------------------------------------------------------------
	webRpa.inPageTip=async function(page,text,opts={}){
		opts=opts||{};
		if(opts.icon===undefined){
			opts.icon=await getDefaultInPageIcon();
		}
		const persistAcrossNav=!!opts.persistAcrossNav;
		const callOpts=copyOptsWithoutPersist(opts);
		const shown=await inPageTipOnce(page,text,callOpts);
		if(!persistAcrossNav){
			return shown;
		}

		if(!this._inPageTipTrackers) this._inPageTipTrackers=new Map();
		const tipId=String(shown?.id || callOpts.id || "").trim();
		if(!tipId){
			return shown;
		}
		callOpts.id=tipId;

		const trackerKey=makeTipTrackerKey(page,opts,tipId);
		clearTipTrackersByPredicate(this,(t,k)=>k===trackerKey);

		const pollRaw=Number(opts.pollMs ?? 500);
		const pollMs=Number.isFinite(pollRaw) ? Math.max(200,pollRaw) : 500;
		const ttlRaw=Number(opts.persistTtlMs ?? 0);
		const ttlMs=Number.isFinite(ttlRaw) ? Math.max(0,ttlRaw) : 0;
		const startedAt=Date.now();
		let running=false;
		const tracker={
			key:trackerKey,
			pageContext:String(page?.context||""),
			tipId,
			stopped:false,
			timer:null,
		};
		tracker.timer=setInterval(async ()=>{
			if(tracker.stopped || running) return;
			running=true;
			try{
				if(ttlMs>0 && (Date.now()-startedAt)>=ttlMs){
					tracker.stopped=true;
					if(tracker.timer) clearInterval(tracker.timer);
					this._inPageTipTrackers.delete(trackerKey);
					return;
				}
				const exists=await inPageTipExists(page,tipId);
				if(!exists){
					await inPageTipOnce(page,text,callOpts);
				}
			}catch(_){
			}finally{
				running=false;
			}
		},pollMs);
		this._inPageTipTrackers.set(trackerKey,tracker);
		return shown;
	};

	//-----------------------------------------------------------------------
	webRpa.inPageTipDismiss=async function(page,idOrAll){
		const ret=await page.callFunction((await import("./InPageUI.mjs")).inPageTipDismiss,[idOrAll]);
		if(!this._inPageTipTrackers) this._inPageTipTrackers=new Map();
		const ctx=String(page?.context||"");
		if(idOrAll===true){
			clearTipTrackersByPredicate(this,(t)=>!ctx || t.pageContext===ctx);
		}else if(typeof idOrAll==="string" && idOrAll.trim()){
			const id=String(idOrAll).trim();
			clearTipTrackersByPredicate(this,(t)=>t.tipId===id && (!ctx || t.pageContext===ctx));
		}else{
			clearTipTrackersByPredicate(this,(t)=>!ctx || t.pageContext===ctx);
		}
		return ret;
	};

	//-----------------------------------------------------------------------
	webRpa.inPagePickDomElement=async function(page,opts){
		return await page.callFunctionHandle((await import("./InPageUI.mjs")).inPagePickDomElement,[opts||{}]);
	};
	
	//-----------------------------------------------------------------------
	webRpa.inPageShowSelector=async function(page,selector,opts){
		return await page.callFunction((await import("./InPageUI.mjs")).inPageShowSelector,[selector,opts]);
	};

	//-----------------------------------------------------------------------
	webRpa.inPageDismissSelector=async function(page,opts){
		return await page.callFunction((await import("./InPageUI.mjs")).inPageDismissSelector,[]);
	};
	
	//-----------------------------------------------------------------------
	webRpa.computeSigKeyForSelector=async function(pageFrame,selector,opts){
		const codeTag=await ensureCodeLib(pageFrame);
		return await pageFrame.callFunction((codeTag,selector,opts)=>{
			let codeLib=globalThis[codeTag];
			console.log("webRpa.computeSigKeyForSelector: ",codeLib.computeSigKeyForSelector);
			return codeLib.computeSigKeyForSelector(selector,opts);
		},[codeTag,selector,opts]);
	};
}
export default WebRpa;
export {WebRpa,ensureCodeLib,sleep};
