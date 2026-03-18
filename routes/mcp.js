var express = require('express');
var cfgVersion = require('../cfg/version.json');

module.exports = function(app) {
	var router = express.Router();
	const MCP_AUTH_TOKEN = (process.env.MCP_AUTH_TOKEN || "").trim();

	function sendResult(res,id,result){
		res.json({jsonrpc:'2.0',id:id===undefined?null:id,result});
	}

	function sendError(res,id,code,message,data){
		const err={code,message};
		if(data!==undefined){
			err.data=data;
		}
		res.json({jsonrpc:'2.0',id:id===undefined?null:id,error:err});
	}

	function getAhSystem(){
		return app.get('AhSystem')||null;
	}

	function isAuthorized(req){
		if(!MCP_AUTH_TOKEN){
			return true;
		}
		const auth = req.headers.authorization || "";
		const prefix = "Bearer ";
		if(!auth.startsWith(prefix)){
			return false;
		}
		const token = auth.slice(prefix.length).trim();
		return token === MCP_AUTH_TOKEN;
	}

	router.post('/', async function(req,res){
		const body=req.body||{};
		const id=body.id;
		const method=body.method;
		const params=body.params||{};
		if(!isAuthorized(req)){
			return res.status(401).json({error:"Unauthorized"});
		}
		if(body.jsonrpc!=='2.0' || !method){
			return sendError(res,id,-32600,'Invalid Request');
		}

		if(method==='initialize'){
			return sendResult(res,id,{
				protocolVersion:'2024-11-05',
				capabilities:{
					tools:{listChanged:false}
				},
				serverInfo:{
					name:'AgentHub MCP Gateway',
					version:cfgVersion.version||'0.0.0'
				}
			});
		}

		if(method==='notifications/initialized'){
			return res.status(204).end();
		}

		const ahSystem=getAhSystem();
		if(!ahSystem){
			return sendError(res,id,-32000,'AgentHub not ready');
		}

		try{
			switch(method){
				case 'tools/list':{
					const tools=await ahSystem.listMcpTools();
					return sendResult(res,id,{tools});
				}
				case 'tools/call':{
					const name=params.name;
					const args=params.arguments||{};
					if(!name){
						return sendError(res,id,-32602,'Missing tool name');
					}
					const result=await ahSystem.callMcpTool(name,args);
					let text;
					if(typeof result==='string'){
						text=result;
					}else{
						try{
							text=JSON.stringify(result,null,2);
						}catch(err){
							text='[Unserializable result]';
						}
					}
					return sendResult(res,id,{
						content:[{type:'text',text:text}],
						structuredContent:(typeof result==='object'&&result!==null)?result:undefined
					});
				}
				default:
					return sendError(res,id,-32601,'Method not found');
			}
		}catch(err){
			return sendError(res,id,-32001,''+err);
		}
	});

	return router;
};
