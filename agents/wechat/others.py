#Auto genterated by Cody
import os
import json
import base64
import urllib.parse
import importlib
##{1IFGSRFVL0MoreImports#
import time
from datetime import datetime, timedelta
import requests
from session import trimJSON
##}1IFGSRFVL0MoreImports#

true=True
false=False
undefined=None
pathLib= os.path
agentURL= pathLib.abspath(__file__)
basePath=pathLib.dirname(agentURL)

##{1IFGSRFVL0StartDoc#
docCache={}
async def get_token():
	url = 'http://47.97.45.223:80/themebee-interface/v1/account/login?appKey=APP_KEY_22e64aae-6251-4fb6-aeda-d121426f3dea&appSecret=APP_SECRET_f30addad-b0a4-471b-8b11-1f5397e18a9d'
	try:
		response = requests.post(url)
		result = json.loads(response.text)
		# print(result)
		if result['code'] == 0:
			token = result['data']
			return token
		else:
			return None
	except requests.exceptions.RequestException as e:
		print("请求异常：", e)
		return None

async def get_hotSpot_list():
	token = await get_token()
	if token:
		url = "http://47.97.45.223:80/themebee-interface/v1/hostspot/list"
		headers = {
			"Authorization": token, 
			'Content-Type': 'application/json;charset=UTF-8',
			'Content-Length': '<calculated when request is sent>'  
			}
		data = {}  
		data = json.dumps(data)
		response = requests.get(url=url, headers=headers, data=data) 
		result = json.loads(response.text)
		assert result['code'] == 0
		assert result['msg'] == 'success'

		if result['data'] and len(result['data']) > 0:
			res = result['data']  
			return res 
		else:
			print("没有获取到有效的数据。")
			return None
	else:
		return None

async def test_hotSpot_relatedNews_get(keyword):
	token = await get_token()
	if token:
		now = datetime.now()
		date_str = now.strftime('%Y-%m-%d')
		# print("当前日期：", date_str)

		seven_days_earlier = now - timedelta(days=14)    
		seven_days_earlier_str = seven_days_earlier.strftime('%Y-%m-%d')
		# print("减去14天后的日期：", seven_days_earlier_str)

		url = f"http://47.97.45.223:80/themebee-interface/v1/news/list/hostspot?end=10&endTime={date_str}&keywords={keyword}&start=0&startTime={seven_days_earlier_str}"

		headers = {
			"Authorization": token, 
			'Content-Type': 'application/json;charset=UTF-8',
			'Content-Length': '<calculated when request is sent>'  
		}
		data = {}  
		# 调用json.dumps()方法，将数据以json格式传递
		data = json.dumps(data)
		# 发送GET请求
		response = requests.get(url=url, headers=headers, data=data) 
		result = json.loads(response.text)
		# print(result)
		assert result['code'] == 0
		assert result['msg'] == 'success'
		return result['data']
	else:
		return None
##}1IFGSRFVL0StartDoc#
##----------------------------------------------------------------------------
async def others(session):
	execInput=None
	context, globalContext = None, None
	self = None
	__Ln = session.language or "CN"
	CheckHi, GetHotWords, ShowWords, ShowWord, GetNews, CallGPT, ShowResult, GetUserWord, CheckData, ShowNoData, Checkword, ShowNoWord, ShowSummary, CheckCache, ShowEnd = None, None, None, None, None, None, None, None, None, None, None, None, None, None, None
	##{1IFGSRFVL0LocalVals#
	##}1IFGSRFVL0LocalVals#
	
	
	def parseAgentArgs(input):
		execInput=input
		##{1IFGSRFVL0ParseArgs#
		##}1IFGSRFVL0ParseArgs#
	
	##{1IFGSRFVL0PreContext#
	##}1IFGSRFVL0PreContext#
	globalContext = session.globalContext
	context = {}
	##{1IFGSRFVL0PostContext#
	##}1IFGSRFVL0PostContext#
	agent,segs = None, {}
	
	async def CheckHi_exec(input):#//:1IFGSRRHI0
		if input.content=="hi":
			return {"seg":GetHotWords,"result":(input),"preSeg":"1IFGSRRHI0","outlet":"1IFGSRRHJ0"}
		#default/else:
		return {"seg":GetUserWord,"result":(input),"preSeg":"1IFGSRRHI0","outlet":"1IFGSRRHI3"}
	segs["CheckHi"]=CheckHi={
		"exec":CheckHi_exec,
		"name":"CheckHi",
		"jaxId":"1IFGSRRHI0",
		"url":"CheckHi@"+agentURL
	}
	
	async def GetHotWords_exec(input):#//:1IFGT19U30
		result=input
		##{1IFGT19U30Code#
		# 热点关键字
		hotSpotData = await get_hotSpot_list() 
		result = hotSpotData
		##}1IFGT19U30Code#
		return {"seg":ShowWords,"result":(result),"preSeg":"1IFGT19U30","outlet":"1IFGT1QRS0"}
	segs["GetHotWords"]=GetHotWords={
		"exec":GetHotWords_exec,
		"name":"GetHotWords",
		"jaxId":"1IFGT19U30",
		"url":"GetHotWords@"+agentURL
	}
	
	async def ShowWords_exec(input):#//:1IFGTJIJ50
		prompt=("今天的趋势热词有如下几个，输入你感兴趣的热词序号或者输入你想问的问题，我可以帮你做快速解读。") or input
		items=[
			{"icon":"/~/-tabos/shared/assets/hudbox.svg","text":"Button","code":0},
		]
		result=""
		item=None
		multi=false
		
		##{1IFGTJIJ50PreCodes#
		idx=0
		items=[]
		for word in input:
			items.append({"icon":"/~/-tabos/shared/assets/gas.svg","text":word,"code":0})
			idx+=1
		##}1IFGTJIJ50PreCodes#
		result,item=await session.askUserRaw({"type":"menu","prompt":prompt,"multiSelect":multi,"items":items})
		##{1IFGTJIJ50PostCodes#
		# result=item.get("text")
		##}1IFGTJIJ50PostCodes#
		if(multi):
			return {"seg":ShowWord,"result":(result),"preSeg":"1IFGTJIJ50","outlet":"1IFGTS7LU0"}
		
		if(item["code"]==0):
			return {"seg":ShowWord,"result":(result),"preSeg":"1IFGTJIJ50","outlet":"1IFGTS7LU0"}
		##{1IFGTJIJ50FinCodes#
		##}1IFGTJIJ50FinCodes#
		return {"result":result}
	segs["ShowWords"]=ShowWords={
		"exec":ShowWords_exec,
		"name":"ShowWords",
		"jaxId":"1IFGTJIJ50",
		"url":"ShowWords@"+agentURL
	}
	
	async def ShowWord_exec(input):#//:1IFGU5A330
		result=input
		role="assistant"
		content=f'''好的，我来看看有关"{input}"的最新情报，稍等一下……'''
		##{1IFGU5A330PreCodes#
		##}1IFGU5A330PreCodes#
		await session.addChatText(role,content,{})
		##{1IFGU5A330PostCodes#
		##}1IFGU5A330PostCodes#
		return {"seg":GetNews,"result":(result),"preSeg":"1IFGU5A330","outlet":"1IFGU5T130"}
	segs["ShowWord"]=ShowWord={
		"exec":ShowWord_exec,
		"name":"ShowWord",
		"jaxId":"1IFGU5A330",
		"url":"ShowWord@"+agentURL
	}
	
	async def GetNews_exec(input):#//:1IFGUAF7T0
		result=input
		##{1IFGUAF7T0Code#
		data = await test_hotSpot_relatedNews_get(input)
		result = data
		##}1IFGUAF7T0Code#
		return {"seg":CheckData,"result":(result),"preSeg":"1IFGUAF7T0","outlet":"1IFGUAPAG0"}
	segs["GetNews"]=GetNews={
		"exec":GetNews_exec,
		"name":"GetNews",
		"jaxId":"1IFGUAF7T0",
		"url":"GetNews@"+agentURL
	}
	
	async def CallGPT_exec(input):#//:1IFGUCBQQ0
		prompt=None
		result=None
		
		opts={
			"mode":"gpt-4o",
			"maxToken":2000,
			"temperature":0,
			"topP":1,
			"fqcP":0,
			"prcP":0,
			"secret":false,
			"responseFormat":"json_object"
		}
		chatMem=CallGPT.get("messages",[])
		seed=""
		if(seed):
			opts.seed=seed
		messages=[
			{"role":"system","content":f'''
你是一个充满智慧和幽默感的文档总结助手。以下是用户基于关键字{context.get('keyword')}提供的数据：{json.dumps(input, indent=4, ensure_ascii=False)}

请你以诙谐有趣的方式输出内容，遵循以下数据结构：
{{ 
	"title": "<string>",
    "content": "<string>",
    "summary": "<string>"
}}

其中：
- title字段，请根据文档中title部分，提炼出关于{context.get('keyword')}的精彩标题，字数不超过20字。
- content字段，请根据文档中所有内容，对{context.get('keyword')}及这一最新事件进行点评，不超过300字。
- summary字段，请根据数据中summary部分，生动地总结关于{context.get('keyword')}的最新事件，字数不超过200字。
'''

},
		]
		prompt=f'''请按照json的格式进行输出。'''
		if(prompt):
			if not isinstance(prompt,str):
				prompt=json.dumps(prompt,indent=4)
			messages.append({"role":"user","content":prompt})
		result=await session.callSegLLM("CallGPT@"+agentURL,opts,messages,true)
		result=trimJSON(result)
		return {"seg":ShowResult,"result":(result),"preSeg":"1IFGUCBQQ0","outlet":"1IFGUFU7E0"}
	segs["CallGPT"]=CallGPT={
		"exec":CallGPT_exec,
		"name":"CallGPT",
		"jaxId":"1IFGUCBQQ0",
		"url":"CallGPT@"+agentURL
	}
	
	async def ShowResult_exec(input):#//:1IFGUG6GU0
		result=input
		role="assistant"
		content=f'''用一句话概括：{input.get("title")}
为什么这样说呢？
{input.get("content")}'''
		##{1IFGUG6GU0PreCodes#
		'''global docCache
		keyword=context.get("keyword")
		curTime=time.time()
		docCache[keyword]={
			"time":curTime,
			"doc":input
		}'''
		##}1IFGUG6GU0PreCodes#
		await session.addChatText(role,content,{})
		##{1IFGUG6GU0PostCodes#
		##}1IFGUG6GU0PostCodes#
		return {"seg":ShowSummary,"result":(result),"preSeg":"1IFGUG6GU0","outlet":"1IFGUI3VI0"}
	segs["ShowResult"]=ShowResult={
		"exec":ShowResult_exec,
		"name":"ShowResult",
		"jaxId":"1IFGUG6GU0",
		"url":"ShowResult@"+agentURL
	}
	
	async def GetUserWord_exec(input):#//:1IFGVFA260
		prompt=None
		result=None
		
		opts={
			"mode":"gpt-4o",
			"maxToken":2000,
			"temperature":0,
			"topP":1,
			"fqcP":0,
			"prcP":0,
			"secret":false,
			"responseFormat":"json_object"
		}
		chatMem=GetUserWord.get("messages",[])
		seed=""
		if(seed):
			opts.seed=seed
		messages=[
			{"role":"system","content":"你是一个从用户的输入中提取与经济、金融、社会热点相关关键词的AI，\n每次收到用户的输入后，你提取其中的关键词，用JSON返回。\n例如，用户输入：“这几天的黄金和白银行情怎么样”\n你输出:\n```\n{\n\t\"keywords\":[\"黄金\",\"白银\"]\n}\n```\n返回的JSON对象中的keywords是你提取到的数组"},
		]
		prompt=f'''用户的输入：
{input}
请提取关键词用JSON数组返回'''
		if(prompt):
			if not isinstance(prompt,str):
				prompt=json.dumps(prompt,indent=4)
			messages.append({"role":"user","content":prompt})
		result=await session.callSegLLM("GetUserWord@"+agentURL,opts,messages,true)
		result=trimJSON(result)
		return {"seg":Checkword,"result":(result),"preSeg":"1IFGVFA260","outlet":"1IFGVT3880"}
	segs["GetUserWord"]=GetUserWord={
		"exec":GetUserWord_exec,
		"name":"GetUserWord",
		"jaxId":"1IFGVFA260",
		"url":"GetUserWord@"+agentURL
	}
	
	async def CheckData_exec(input):#//:1IFGVUPC00
		if (not input) or (len(input)==0):
			return {"seg":ShowNoData,"result":(input),"preSeg":"1IFGVUPC00","outlet":"1IFH052E20"}
		#default/else:
		return {"seg":CheckCache,"result":(input),"preSeg":"1IFGVUPC00","outlet":"1IFH052E21"}
	segs["CheckData"]=CheckData={
		"exec":CheckData_exec,
		"name":"CheckData",
		"jaxId":"1IFGVUPC00",
		"url":"CheckData@"+agentURL
	}
	
	async def ShowNoData_exec(input):#//:1IFH00CQK0
		result=input
		role="assistant"
		content="f'''暂时没有相关的情报呢\n您可以使用《碰词》小程序查看更多的投资热点和机会。\n[对话结束]\n'''"
		await session.addChatText(role,content,{})
		return {"result":result}
	segs["ShowNoData"]=ShowNoData={
		"exec":ShowNoData_exec,
		"name":"ShowNoData",
		"jaxId":"1IFH00CQK0",
		"url":"ShowNoData@"+agentURL
	}
	
	async def Checkword_exec(input):#//:1IFH03AII0
		##{1IFH03AII0Start#
		##}1IFH03AII0Start#
		if input and (input.get("keywords")) and (input.get("keywords")[0]):
			output=input.get("keywords")[0]
			return {"seg":ShowWord,"result":(output),"preSeg":"1IFH03AII0","outlet":"1IFH052E23"}
		##{1IFH03AII0Post#
		##}1IFH03AII0Post#
		#default/else:
		return {"seg":ShowNoWord,"result":(input),"preSeg":"1IFH03AII0","outlet":"1IFH052E24"}
	segs["Checkword"]=Checkword={
		"exec":Checkword_exec,
		"name":"Checkword",
		"jaxId":"1IFH03AII0",
		"url":"Checkword@"+agentURL
	}
	
	async def ShowNoWord_exec(input):#//:1IFH0CEHI0
		result=input
		role="assistant"
		content=f'''抱歉，没能从您的输入找到合适关键词
您可以使用《碰词》小程序查看更多的投资热点和机会。
[对话结束]
'''
		await session.addChatText(role,content,{})
		return {"result":result}
	segs["ShowNoWord"]=ShowNoWord={
		"exec":ShowNoWord_exec,
		"name":"ShowNoWord",
		"jaxId":"1IFH0CEHI0",
		"url":"ShowNoWord@"+agentURL
	}
	
	async def ShowSummary_exec(input):#//:1IFH0H8CU0
		result=input
		role="assistant"
		content=f'''总结一下：
{input.get("summary")}

更多的信息以及相关的投资机会，可以在“碰词”小程序里找到哦。
'''
		await session.addChatText(role,content,{})
		return {"seg":ShowEnd,"result":(result),"preSeg":"1IFH0H8CU0","outlet":"1IFH0LG0R0"}
	segs["ShowSummary"]=ShowSummary={
		"exec":ShowSummary_exec,
		"name":"ShowSummary",
		"jaxId":"1IFH0H8CU0",
		"url":"ShowSummary@"+agentURL
	}
	
	async def CheckCache_exec(input):#//:1IFH4PP700
		##{1IFH4PP700Start#
		global docCache
		cachedDoc=None
		keyword=context.get('keyword')
		curTime=time.time()
		cached=docCache.get(keyword)
		if cached:
			cacheTime=cached.get("time",0)
			if curTime-cacheTime<5*60:
				cachedDoc=cached.get("doc")
		##}1IFH4PP700Start#
		if not cachedDoc:
			return {"seg":CallGPT,"result":(input),"preSeg":"1IFH4PP700","outlet":"1IFH4RDAD0"}
		##{1IFH4PP700Post#
		input=cachedDoc
		##}1IFH4PP700Post#
		#default/else:
		return {"seg":ShowResult,"result":(input),"preSeg":"1IFH4PP700","outlet":"1IFH4RDAD1"}
	segs["CheckCache"]=CheckCache={
		"exec":CheckCache_exec,
		"name":"CheckCache",
		"jaxId":"1IFH4PP700",
		"url":"CheckCache@"+agentURL
	}
	
	async def ShowEnd_exec(input):#//:1IFH5V5OP0
		result=input
		role="assistant"
		content="[对话结束]"
		await session.addChatText(role,content,{})
		return {"result":result}
	segs["ShowEnd"]=ShowEnd={
		"exec":ShowEnd_exec,
		"name":"ShowEnd",
		"jaxId":"1IFH5V5OP0",
		"url":"ShowEnd@"+agentURL
	}
	
	async def execAgent(input):
		result = None
		parseAgentArgs(input)
		##{1IFGSRFVL0PreEntry#
		##}1IFGSRFVL0PreEntry#
		result = {"seg":CheckHi,"input":input}
		##{1IFGSRFVL0PostEntry#
		##}1IFGSRFVL0PostEntry#
		return result
	agent = {
		"isAIAgent": true,
		"session": session,
		"name": "others",
		"url": agentURL,
		"baseDir": basePath,
		"autoStart": true,
		"jaxId": "1IFGSRFVL0",
		"context": context,
		"livingSeg": None,
		"execChat": execAgent,
		##{1IFGSRFVL0MoreAgentAttrs#
		##}1IFGSRFVL0MoreAgentAttrs#
	}
	##{1IFGSRFVL0PostAgent#
	##}1IFGSRFVL0PostAgent#
	return agent
##{1IFGSRFVL0ExCodes#
##}1IFGSRFVL0ExCodes#

ChatAPI=None

default=others
__all__=["default","others","ChatAPI"]
""">>>CodyExport
let ChatAPI,Exports;

return {api:ChatAPI,export:Exports};
>>>CodyExport"""
#Cody Project Doc
#{
#	"type": "docfile",
#	"def": "DocAIAgent",
#	"jaxId": "1IFGSRFVL0",
#	"attrs": {
#		"editObjs": {
#			"jaxId": "1IFGSRFVL1",
#			"attrs": {
#				"others": {
#					"type": "objclass",
#					"def": "ObjClass",
#					"jaxId": "1IFGSRFVM0",
#					"attrs": {
#						"exportType": "UI Data Template",
#						"constructArgs": {
#							"jaxId": "1IFGSRFVM1",
#							"attrs": {}
#						},
#						"superClass": "",
#						"properties": {
#							"jaxId": "1IFGSRFVM2",
#							"attrs": {}
#						},
#						"functions": {
#							"jaxId": "1IFGSRFVM3",
#							"attrs": {}
#						},
#						"mockupOnly": "false",
#						"nullMockup": "false"
#					},
#					"mockups": {}
#				}
#			}
#		},
#		"agent": {
#			"jaxId": "1IFGSRFVL2",
#			"attrs": {}
#		},
#		"entry": "",
#		"autoStart": "true",
#		"inBrowser": "true",
#		"debug": "true",
#		"apiArgs": {
#			"jaxId": "1IFGSRFVL3",
#			"attrs": {}
#		},
#		"localVars": {
#			"jaxId": "1IFGSRFVL4",
#			"attrs": {}
#		},
#		"context": {
#			"jaxId": "1IFGSRFVL5",
#			"attrs": {}
#		},
#		"globalMockup": {
#			"jaxId": "1IFGSRFVL6",
#			"attrs": {}
#		},
#		"segs": {
#			"attrs": [
#				{
#					"type": "aiseg",
#					"def": "brunch",
#					"jaxId": "1IFGSRRHI0",
#					"attrs": {
#						"id": "CheckHi",
#						"viewName": "",
#						"label": "",
#						"x": "70",
#						"y": "205",
#						"desc": "这是一个AISeg。",
#						"codes": "false",
#						"mkpInput": "$$input$$",
#						"segMark": "None",
#						"context": {
#							"jaxId": "1IFGSRRHI1",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"global": {
#							"jaxId": "1IFGSRRHI2",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"outlet": {
#							"jaxId": "1IFGSRRHI3",
#							"attrs": {
#								"id": "Default",
#								"desc": "输出节点。",
#								"output": ""
#							},
#							"linkedSeg": "1IFGVFA260"
#						},
#						"outlets": {
#							"attrs": [
#								{
#									"type": "aioutlet",
#									"def": "AIConditionOutlet",
#									"jaxId": "1IFGSRRHJ0",
#									"attrs": {
#										"id": "IsHi",
#										"desc": "输出节点。",
#										"output": "",
#										"codes": "false",
#										"context": {
#											"jaxId": "1IFGSRRHJ1",
#											"attrs": {
#												"cast": ""
#											}
#										},
#										"global": {
#											"jaxId": "1IFGSRRHJ2",
#											"attrs": {
#												"cast": ""
#											}
#										},
#										"condition": "#input.content==\"hi\""
#									},
#									"linkedSeg": "1IFGT19U30"
#								}
#							]
#						}
#					}
#				},
#				{
#					"type": "aiseg",
#					"def": "code",
#					"jaxId": "1IFGT19U30",
#					"attrs": {
#						"id": "GetHotWords",
#						"viewName": "",
#						"label": "",
#						"x": "315",
#						"y": "125",
#						"desc": "这是一个AISeg。",
#						"mkpInput": "$$input$$",
#						"segMark": "None",
#						"context": {
#							"jaxId": "1IFGT21M70",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"global": {
#							"jaxId": "1IFGT21M71",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"outlet": {
#							"jaxId": "1IFGT1QRS0",
#							"attrs": {
#								"id": "Result",
#								"desc": "输出节点。"
#							},
#							"linkedSeg": "1IFGTJIJ50"
#						},
#						"result": "#input"
#					}
#				},
#				{
#					"type": "aiseg",
#					"def": "askMenu",
#					"jaxId": "1IFGTJIJ50",
#					"attrs": {
#						"id": "ShowWords",
#						"viewName": "",
#						"label": "",
#						"x": "590",
#						"y": "125",
#						"desc": "这是一个AISeg。",
#						"codes": "true",
#						"mkpInput": "$$input$$",
#						"segMark": "None",
#						"prompt": "今天的趋势热词有如下几个，输入你感兴趣的热词序号或者输入你想问的问题，我可以帮你做快速解读。",
#						"multi": "false",
#						"withChat": "true",
#						"outlet": {
#							"jaxId": "1IFGTQCJV0",
#							"attrs": {
#								"id": "ChatInput",
#								"desc": "输出节点。",
#								"codes": "false"
#							}
#						},
#						"outlets": {
#							"attrs": [
#								{
#									"type": "aioutlet",
#									"def": "AIButtonOutlet",
#									"jaxId": "1IFGTS7LU0",
#									"attrs": {
#										"id": "Result",
#										"desc": "输出节点。",
#										"text": "Button",
#										"result": "",
#										"codes": "false",
#										"context": {
#											"jaxId": "1IFGTSNIR0",
#											"attrs": {
#												"cast": ""
#											}
#										},
#										"global": {
#											"jaxId": "1IFGTSNIR1",
#											"attrs": {
#												"cast": ""
#											}
#										}
#									},
#									"linkedSeg": "1IFGU5A330"
#								}
#							]
#						},
#						"silent": "false"
#					}
#				},
#				{
#					"type": "aiseg",
#					"def": "output",
#					"jaxId": "1IFGU5A330",
#					"attrs": {
#						"id": "ShowWord",
#						"viewName": "",
#						"label": "",
#						"x": "850",
#						"y": "110",
#						"desc": "这是一个AISeg。",
#						"codes": "true",
#						"mkpInput": "$$input$$",
#						"segMark": "None",
#						"context": {
#							"jaxId": "1IFGU5T180",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"global": {
#							"jaxId": "1IFGU5T181",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"role": "Assistant",
#						"text": "#f'''好的，我来看看有关\"{input}\"的最新情报，稍等一下……'''",
#						"outlet": {
#							"jaxId": "1IFGU5T130",
#							"attrs": {
#								"id": "Result",
#								"desc": "输出节点。"
#							},
#							"linkedSeg": "1IFGUAF7T0"
#						}
#					}
#				},
#				{
#					"type": "aiseg",
#					"def": "code",
#					"jaxId": "1IFGUAF7T0",
#					"attrs": {
#						"id": "GetNews",
#						"viewName": "",
#						"label": "",
#						"x": "1105",
#						"y": "110",
#						"desc": "这是一个AISeg。",
#						"mkpInput": "$$input$$",
#						"segMark": "None",
#						"context": {
#							"jaxId": "1IFGUAUMN0",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"global": {
#							"jaxId": "1IFGUAUMN1",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"outlet": {
#							"jaxId": "1IFGUAPAG0",
#							"attrs": {
#								"id": "Result",
#								"desc": "输出节点。"
#							},
#							"linkedSeg": "1IFGVUPC00"
#						},
#						"result": "#input"
#					}
#				},
#				{
#					"type": "aiseg",
#					"def": "callLLM",
#					"jaxId": "1IFGUCBQQ0",
#					"attrs": {
#						"id": "CallGPT",
#						"viewName": "",
#						"label": "",
#						"x": "1830",
#						"y": "110",
#						"desc": "执行一次LLM调用。",
#						"codes": "false",
#						"mkpInput": "$$input$$",
#						"segMark": "None",
#						"context": {
#							"jaxId": "1IFGUFU7H0",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"global": {
#							"jaxId": "1IFGUFU7H1",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"platform": "\"OpenAI\"",
#						"mode": "gpt-4o",
#						"system": "#f'''\n你是一个充满智慧和幽默感的文档总结助手。以下是用户基于关键字{context.get('keyword')}提供的数据：{json.dumps(input, indent=4, ensure_ascii=False)}\n\n请你以诙谐有趣的方式输出内容，遵循以下数据结构：\n{{ \n\t\"title\": \"<string>\",\n    \"content\": \"<string>\",\n    \"summary\": \"<string>\"\n}}\n\n其中：\n- title字段，请根据文档中title部分，提炼出关于{context.get('keyword')}的精彩标题，字数不超过20字。\n- content字段，请根据文档中所有内容，对{context.get('keyword')}及这一最新事件进行点评，不超过300字。\n- summary字段，请根据数据中summary部分，生动地总结关于{context.get('keyword')}的最新事件，字数不超过200字。\n'''\n\n",
#						"temperature": "0",
#						"maxToken": "2000",
#						"topP": "1",
#						"fqcP": "0",
#						"prcP": "0",
#						"messages": {
#							"attrs": []
#						},
#						"prompt": "#f'''请按照json的格式进行输出。'''",
#						"seed": "",
#						"outlet": {
#							"jaxId": "1IFGUFU7E0",
#							"attrs": {
#								"id": "Result",
#								"desc": "输出节点。"
#							},
#							"linkedSeg": "1IFGUG6GU0"
#						},
#						"secret": "false",
#						"allowCheat": "false",
#						"GPTCheats": {
#							"attrs": []
#						},
#						"shareChatName": "",
#						"keepChat": "No",
#						"clearChat": "2",
#						"apiFiles": {
#							"attrs": []
#						},
#						"parallelFunction": "false",
#						"responseFormat": "json_object"
#					}
#				},
#				{
#					"type": "aiseg",
#					"def": "output",
#					"jaxId": "1IFGUG6GU0",
#					"attrs": {
#						"id": "ShowResult",
#						"viewName": "",
#						"label": "",
#						"x": "2075",
#						"y": "110",
#						"desc": "这是一个AISeg。",
#						"codes": "true",
#						"mkpInput": "$$input$$",
#						"segMark": "None",
#						"context": {
#							"jaxId": "1IFGUI3VK0",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"global": {
#							"jaxId": "1IFGUI3VK1",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"role": "Assistant",
#						"text": "#f'''用一句话概括：{input.get(\"title\")}\n为什么这样说呢？\n{input.get(\"content\")}'''",
#						"outlet": {
#							"jaxId": "1IFGUI3VI0",
#							"attrs": {
#								"id": "Result",
#								"desc": "输出节点。"
#							},
#							"linkedSeg": "1IFH0H8CU0"
#						}
#					}
#				},
#				{
#					"type": "aiseg",
#					"def": "callLLM",
#					"jaxId": "1IFGVFA260",
#					"attrs": {
#						"id": "GetUserWord",
#						"viewName": "",
#						"label": "",
#						"x": "315",
#						"y": "315",
#						"desc": "执行一次LLM调用。",
#						"codes": "false",
#						"mkpInput": "$$input$$",
#						"segMark": "None",
#						"context": {
#							"jaxId": "1IFGVT38E0",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"global": {
#							"jaxId": "1IFGVT38E1",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"platform": "\"OpenAI\"",
#						"mode": "gpt-4o",
#						"system": "你是一个从用户的输入中提取与经济、金融、社会热点相关关键词的AI，\n每次收到用户的输入后，你提取其中的关键词，用JSON返回。\n例如，用户输入：“这几天的黄金和白银行情怎么样”\n你输出:\n```\n{\n\t\"keywords\":[\"黄金\",\"白银\"]\n}\n```\n返回的JSON对象中的keywords是你提取到的数组",
#						"temperature": "0",
#						"maxToken": "2000",
#						"topP": "1",
#						"fqcP": "0",
#						"prcP": "0",
#						"messages": {
#							"attrs": []
#						},
#						"prompt": "#f'''用户的输入：\n{input}\n请提取关键词用JSON数组返回'''",
#						"seed": "",
#						"outlet": {
#							"jaxId": "1IFGVT3880",
#							"attrs": {
#								"id": "Result",
#								"desc": "输出节点。"
#							},
#							"linkedSeg": "1IFH03AII0"
#						},
#						"secret": "false",
#						"allowCheat": "false",
#						"GPTCheats": {
#							"attrs": []
#						},
#						"shareChatName": "",
#						"keepChat": "No",
#						"clearChat": "2",
#						"apiFiles": {
#							"attrs": []
#						},
#						"parallelFunction": "false",
#						"responseFormat": "json_object"
#					}
#				},
#				{
#					"type": "aiseg",
#					"def": "brunch",
#					"jaxId": "1IFGVUPC00",
#					"attrs": {
#						"id": "CheckData",
#						"viewName": "",
#						"label": "",
#						"x": "1320",
#						"y": "110",
#						"desc": "这是一个AISeg。",
#						"codes": "false",
#						"mkpInput": "$$input$$",
#						"segMark": "None",
#						"context": {
#							"jaxId": "1IFH05VAN0",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"global": {
#							"jaxId": "1IFH05VAN1",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"outlet": {
#							"jaxId": "1IFH052E21",
#							"attrs": {
#								"id": "Default",
#								"desc": "输出节点。",
#								"output": ""
#							},
#							"linkedSeg": "1IFH4PP700"
#						},
#						"outlets": {
#							"attrs": [
#								{
#									"type": "aioutlet",
#									"def": "AIConditionOutlet",
#									"jaxId": "1IFH052E20",
#									"attrs": {
#										"id": "NoData",
#										"desc": "输出节点。",
#										"output": "",
#										"codes": "false",
#										"context": {
#											"jaxId": "1IFH05VAN2",
#											"attrs": {
#												"cast": ""
#											}
#										},
#										"global": {
#											"jaxId": "1IFH05VAN3",
#											"attrs": {
#												"cast": ""
#											}
#										},
#										"condition": "#(not input) or (len(input)==0)"
#									},
#									"linkedSeg": "1IFH00CQK0"
#								}
#							]
#						}
#					}
#				},
#				{
#					"type": "aiseg",
#					"def": "output",
#					"jaxId": "1IFH00CQK0",
#					"attrs": {
#						"id": "ShowNoData",
#						"viewName": "",
#						"label": "",
#						"x": "1570",
#						"y": "25",
#						"desc": "这是一个AISeg。",
#						"codes": "false",
#						"mkpInput": "$$input$$",
#						"segMark": "flag.svg",
#						"context": {
#							"jaxId": "1IFH05VAN4",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"global": {
#							"jaxId": "1IFH05VAN5",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"role": "Assistant",
#						"text": "f'''暂时没有相关的情报呢\n您可以使用《碰词》小程序查看更多的投资热点和机会。\n[对话结束]\n'''",
#						"outlet": {
#							"jaxId": "1IFH052E22",
#							"attrs": {
#								"id": "Result",
#								"desc": "输出节点。"
#							}
#						}
#					}
#				},
#				{
#					"type": "aiseg",
#					"def": "brunch",
#					"jaxId": "1IFH03AII0",
#					"attrs": {
#						"id": "Checkword",
#						"viewName": "",
#						"label": "",
#						"x": "1085",
#						"y": "315",
#						"desc": "这是一个AISeg。",
#						"codes": "true",
#						"mkpInput": "$$input$$",
#						"segMark": "None",
#						"context": {
#							"jaxId": "1IFH05VAN6",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"global": {
#							"jaxId": "1IFH05VAN7",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"outlet": {
#							"jaxId": "1IFH052E24",
#							"attrs": {
#								"id": "Default",
#								"desc": "输出节点。",
#								"output": "#input[0]"
#							},
#							"linkedSeg": "1IFH0CEHI0"
#						},
#						"outlets": {
#							"attrs": [
#								{
#									"type": "aioutlet",
#									"def": "AIConditionOutlet",
#									"jaxId": "1IFH052E23",
#									"attrs": {
#										"id": "HasWord",
#										"desc": "输出节点。",
#										"output": "#input.get(\"keywords\")[0]",
#										"codes": "false",
#										"context": {
#											"jaxId": "1IFH05VAN8",
#											"attrs": {
#												"cast": ""
#											}
#										},
#										"global": {
#											"jaxId": "1IFH05VAN9",
#											"attrs": {
#												"cast": ""
#											}
#										},
#										"condition": "#input and (input.get(\"keywords\")) and (input.get(\"keywords\")[0])"
#									},
#									"linkedSeg": "1IFH0F81P0"
#								}
#							]
#						}
#					}
#				},
#				{
#					"type": "aiseg",
#					"def": "output",
#					"jaxId": "1IFH0CEHI0",
#					"attrs": {
#						"id": "ShowNoWord",
#						"viewName": "",
#						"label": "",
#						"x": "1355",
#						"y": "330",
#						"desc": "这是一个AISeg。",
#						"codes": "false",
#						"mkpInput": "$$input$$",
#						"segMark": "flag.svg",
#						"context": {
#							"jaxId": "1IFH0EBEA0",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"global": {
#							"jaxId": "1IFH0EBEA1",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"role": "Assistant",
#						"text": "#f'''抱歉，没能从您的输入找到合适关键词\n您可以使用《碰词》小程序查看更多的投资热点和机会。\n[对话结束]\n'''",
#						"outlet": {
#							"jaxId": "1IFH0EBE60",
#							"attrs": {
#								"id": "Result",
#								"desc": "输出节点。"
#							}
#						}
#					}
#				},
#				{
#					"type": "aiseg",
#					"def": "connector",
#					"jaxId": "1IFH0F81P0",
#					"attrs": {
#						"id": "",
#						"label": "New AI Seg",
#						"x": "1250",
#						"y": "190",
#						"outlet": {
#							"jaxId": "1IFH0LG100",
#							"attrs": {
#								"id": "Outlet",
#								"desc": "输出节点。"
#							},
#							"linkedSeg": "1IFH0FEHF0"
#						},
#						"dir": "R2L"
#					}
#				},
#				{
#					"type": "aiseg",
#					"def": "connector",
#					"jaxId": "1IFH0FEHF0",
#					"attrs": {
#						"id": "",
#						"label": "New AI Seg",
#						"x": "895",
#						"y": "190",
#						"outlet": {
#							"jaxId": "1IFH0LG101",
#							"attrs": {
#								"id": "Outlet",
#								"desc": "输出节点。"
#							},
#							"linkedSeg": "1IFGU5A330"
#						},
#						"dir": "R2L"
#					}
#				},
#				{
#					"type": "aiseg",
#					"def": "output",
#					"jaxId": "1IFH0H8CU0",
#					"attrs": {
#						"id": "ShowSummary",
#						"viewName": "",
#						"label": "",
#						"x": "2320",
#						"y": "110",
#						"desc": "这是一个AISeg。",
#						"codes": "false",
#						"mkpInput": "$$input$$",
#						"segMark": "None",
#						"context": {
#							"jaxId": "1IFH0LG102",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"global": {
#							"jaxId": "1IFH0LG103",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"role": "Assistant",
#						"text": "#f'''总结一下：\n{input.get(\"summary\")}\n\n更多的信息以及相关的投资机会，可以在“碰词”小程序里找到哦。\n'''",
#						"outlet": {
#							"jaxId": "1IFH0LG0R0",
#							"attrs": {
#								"id": "Result",
#								"desc": "输出节点。"
#							},
#							"linkedSeg": "1IFH5V5OP0"
#						}
#					}
#				},
#				{
#					"type": "aiseg",
#					"def": "brunch",
#					"jaxId": "1IFH4PP700",
#					"attrs": {
#						"id": "CheckCache",
#						"viewName": "",
#						"label": "",
#						"x": "1570",
#						"y": "190",
#						"desc": "这是一个AISeg。",
#						"codes": "true",
#						"mkpInput": "$$input$$",
#						"segMark": "None",
#						"context": {
#							"jaxId": "1IFH4RDAJ0",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"global": {
#							"jaxId": "1IFH4RDAJ1",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"outlet": {
#							"jaxId": "1IFH4RDAD1",
#							"attrs": {
#								"id": "Default",
#								"desc": "输出节点。",
#								"output": ""
#							},
#							"linkedSeg": "1IFH54BRU0"
#						},
#						"outlets": {
#							"attrs": [
#								{
#									"type": "aioutlet",
#									"def": "AIConditionOutlet",
#									"jaxId": "1IFH4RDAD0",
#									"attrs": {
#										"id": "NoCache",
#										"desc": "输出节点。",
#										"output": "",
#										"codes": "false",
#										"context": {
#											"jaxId": "1IFH4RDAJ2",
#											"attrs": {
#												"cast": ""
#											}
#										},
#										"global": {
#											"jaxId": "1IFH4RDAJ3",
#											"attrs": {
#												"cast": ""
#											}
#										},
#										"condition": "#not cachedDoc"
#									},
#									"linkedSeg": "1IFGUCBQQ0"
#								}
#							]
#						}
#					}
#				},
#				{
#					"type": "aiseg",
#					"def": "connectorL",
#					"jaxId": "1IFH54BRU0",
#					"attrs": {
#						"id": "",
#						"label": "New AI Seg",
#						"x": "1955",
#						"y": "205",
#						"outlet": {
#							"jaxId": "1IFH54UEA0",
#							"attrs": {
#								"id": "Outlet",
#								"desc": "输出节点。"
#							},
#							"linkedSeg": "1IFGUG6GU0"
#						},
#						"dir": "L2R"
#					}
#				},
#				{
#					"type": "aiseg",
#					"def": "output",
#					"jaxId": "1IFH5V5OP0",
#					"attrs": {
#						"id": "ShowEnd",
#						"viewName": "",
#						"label": "",
#						"x": "2585",
#						"y": "110",
#						"desc": "这是一个AISeg。",
#						"codes": "false",
#						"mkpInput": "$$input$$",
#						"segMark": "flag.svg",
#						"context": {
#							"jaxId": "1IFH62ONC0",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"global": {
#							"jaxId": "1IFH62ONC1",
#							"attrs": {
#								"cast": ""
#							}
#						},
#						"role": "Assistant",
#						"text": "[对话结束]",
#						"outlet": {
#							"jaxId": "1IFH62ON80",
#							"attrs": {
#								"id": "Result",
#								"desc": "输出节点。"
#							}
#						}
#					}
#				}
#			]
#		},
#		"desc": "这是一个AI智能体。",
#		"exportAPI": "false",
#		"exportAddOn": "false",
#		"addOnOpts": ""
#	}
#}