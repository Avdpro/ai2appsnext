
const dotEnv=require('dotenv');
const envFileName=process.argv[2];
if(envFileName){
	if(envFileName.indexOf("/")>=0){
		dotEnv.config({path:envFileName});
	}else{
		dotEnv.config({path:"./"+envFileName});
	}
}else {
	dotEnv.config();
}

var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const WebSocket = require('ws');
//const cors = require('cors');
var envCfg=null;

// Install process-level safety net only once, even if app.js is required multiple times.
if (!global.__AA_GLOBAL_ERROR_HANDLER__) {
	global.__AA_GLOBAL_ERROR_HANDLER__ = true;

	process.on('unhandledRejection', (reason, promise) => {
		console.error('[GlobalError] Unhandled Rejection:', reason);
		console.error('[GlobalError] Promise:', promise);
	});

	process.on('uncaughtException', (err) => {
		console.error('[GlobalError] Uncaught Exception:', err);
	});
}

var indexRouter = require('./routes/index');
var swrootRouter= require('./routes/swroot');
var wsRouter=require('./routes/ws');
var mcpRouter=require('./routes/mcp');


var app = express();

let AgentHub_FileLibPath=process.env.AGENT_HUB_FileLibDir||process.env.AABOTS_FileLibPath||"filelib";
if(!path.isAbsolute(AgentHub_FileLibPath)){
	AgentHub_FileLibPath=path.join(__dirname,AgentHub_FileLibPath);
}

//app.use(cors());
app.initCokeCodesApp=async function(){
	let mongoDB,mongoURL;
	const useManageFlows=String(process.env.MANAGE_FLOWS || "").toUpperCase()==="TRUE";

	envCfg=app.get("env");
	mongoURL=app.get("mongoURL")||"mongodb://127.0.0.1:20000";
	console.log("Application env: "+envCfg);
	// view engine setup
	app.set('views', path.join(__dirname, 'views'));
	app.set('view engine', 'pug');
	app.set("AppHomePath",__dirname);

	app.use(logger('dev'));
	
	app.use(express.json({limit: '200mb'}));
	app.use(express.urlencoded({limit: '200mb', extended: false }));
	app.use(cookieParser());
	app.use(express.static(path.join(__dirname, 'public')));
	app.use("/-hub",express.static(AgentHub_FileLibPath));
	//app.use("/-+hubfile",express.static(AgentHub_FileLibPath));

	mongoDB=null;
	app.set('WebSocketSelectorMap',new Map());

	app.use('/', indexRouter);
	app.use('//', swrootRouter);
	app.use('/ws', wsRouter(app));
	app.use('/mcp',mcpRouter(app));

	// RPA Flows APIs (opt-in via env: RPAFLOWS=true)
	{
		if (String(process.env.RPAFLOWS || "").toUpperCase() === "TRUE") {
			const rpaFlowsRouter = express.Router();
			let mountedAny = false;
			try {
				const esmModule = await import('./routes/APIRPAFlowAudit.mjs');
				esmModule.default(app, rpaFlowsRouter);
				mountedAny = true;
				console.log("[RPAFLOWS] audit routes loaded");
			} catch (err) {
				console.warn("[RPAFLOWS] skip audit routes: failed to load routes/APIRPAFlowAudit.mjs");
				console.warn("[RPAFLOWS] reason:", err && (err.message || err));
			}
			try {
				const esmModule = await import('./routes/APIRPAFlowBuilder.mjs');
				esmModule.default(app, rpaFlowsRouter);
				mountedAny = true;
				console.log("[RPAFLOWS] builder routes loaded");
			} catch (err) {
				console.warn("[RPAFLOWS] skip builder routes: failed to load routes/APIRPAFlowBuilder.mjs");
				console.warn("[RPAFLOWS] reason:", err && (err.message || err));
			}
			if (mountedAny) {
				app.use('/rpaflows', rpaFlowsRouter);
				console.log("[RPAFLOWS] enabled: /rpaflows");
			}
		}
	}
	
	//Shadow chat:
	{
		if (process.env.SHADOW_CHAT === "TRUE") {
			const shadowRouter = express.Router();
			await (async () => {
				const esmModule = await import('./handlers/APIShadowChat.mjs');
				esmModule.default(app, shadowRouter);
			})();
			app.use('/shadow', shadowRouter);
		}
	}
	
	//Payments:
	{
		if(process.env.PAYMENT==="TRUE") {
			const paymentsRouter = express.Router();
			//Paypal handlers::
			await (async () => {
				const esmModule = await import('./payments/paypal.mjs');
				esmModule.default(app, paymentsRouter);
			})();
			
			//Stripe-WX handlers:
			/*await (async () => {
				const esmModule = await import('./payments//stripe_ap.mjs');
				esmModule.default(app, paymentsRouter);
			})();*/
			app.use('/payments', paymentsRouter);
		}else{
			//Forward all calls to root:
			await (async () => {
				const esmModule = await import('./payments/local.mjs');
				esmModule.default(app);
			})();
		}
	}
	// catch 404 and forward to error handler
	app.use(function(req, res, next) {
		next(createError(404));
	});

	// error handler
	app.use(function(err, req, res, next) {
		// set locals, only providing error in development
		res.locals.message = err.message;
		res.locals.error = req.app.get('env') === 'development' ? err : {};

		// render the error page
		res.status(err.status || 500);
		res.render('error');
	});
	
	//Test WebDrive
	if(false){
		await (async () => {
			const esmModule = await import('./rpa/test.mjs');
			esmModule.default();
		})();
	}
};

//---------------------------------------------------------------------------
app.setupWebSocket=async function(server){
	let wss,selectorMap;
	selectorMap=app.get("WebSocketSelectorMap");
	wss=app.wss=new WebSocket.Server({ server:server,maxPayload:100*1024*1024 });
	wss.on('connection',(ws)=>{
		function handleMessage(message){
			let msgJSON,selector;
			if (message instanceof Buffer || message instanceof Uint8Array) {
				message = message.toString();
			}
			if(typeof(message)!=='string'){
				ws.close(1003,"Only JSON-text message allowed");
				return;
			}
			try{
				msgJSON=JSON.parse(message);
			}catch (err){
				ws.close(1003,"Only JSON-text message allowed");
				return;
			}
			if(msgJSON.msg!=="CONNECT"){
				ws.close(1002,"First message must be CONNECT");
				return;
			}
			selector=msgJSON.selector;
			selector=selectorMap.get(selector);
			if(!selector){
				ws.close(1002,"Can't find handler");
				return;
			}
			selector(ws,msgJSON);
			ws.aaConnected=true;
			ws.off('message',handleMessage);
		}
		ws.aaConnected=false;
		ws.on('message',handleMessage);
	});
};

module.exports = app;
