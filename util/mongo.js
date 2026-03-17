const { MongoClient,ObjectId } = require("mongodb");
var __Proto;

var MongoDB=function(app,url){
	this.client = new MongoClient(url);
	this.dbMap={};
	this.clDBMap={};
};

__Proto=MongoDB.prototype={};

//---------------------------------------------------------------------------
//初始化数据库
__Proto.initDB=async function() {
	await this.client.connect();
};

//---------------------------------------------------------------------------
//得到一个数据表
__Proto.collection=function(dbName,clName) {
	let db,cl,clMap;
	db=this.dbMap[dbName];
	clMap=this.clDBMap[dbName];
	if(!db){
		db=this.client.db(dbName);
		this.dbMap[dbName]=db;
		clMap=this.clDBMap[dbName]={};
	}
	cl=clMap[clName];
	if(!cl){
		cl=db.collection(clName);
		clMap[clName]=cl;
	}
	return cl;
};

//---------------------------------------------------------------------------
__Proto.cappedCollection=async function (dbName, collectionName, sizeLimit) {
	let client,db,cl,clMap;
	client=this.client;
	try {
		db=this.dbMap[dbName];
		if(!db) {
			db = client.db(dbName);
			this.dbMap[dbName]=db;
			this.clDBMap[dbName]={};
		}
		clMap=this.clDBMap[dbName];
		
		// 1. 判断集合是否存在
		const collections = await db.listCollections({ name: collectionName }).toArray();
		if (!collections.length) {
			// 2. 创建有尺寸限制的集合
			await db.createCollection(collectionName, {
				capped: true,
				size: sizeLimit  // 以字节为单位的最大尺寸
			});
		}
	} catch (err) {
		console.error(err);
	}
	cl=clMap[collectionName];
	if(!cl){
		cl=db.collection(collectionName);
		clMap[collectionName]=cl;
	}
	return cl;
};

//---------------------------------------------------------------------------
__Proto.ensureIndex=async function(dbName,collectionName,key,mode=1){
	let client,db,cl,clMap;
	client=this.client;
	try {
		db=this.dbMap[dbName];
		if(!db) {
			db = client.db(dbName);
			this.dbMap[dbName]=db;
			this.clDBMap[dbName]={};
		}
		clMap=this.clDBMap[dbName];
		cl=clMap[collectionName];
		if(!cl){
			cl=db.collection(collectionName);
			clMap[collectionName]=cl;
		}
		const indexes = await cl.listIndexes().toArray();
		const isActionIndexed = indexes.some(index => index.key[key] !== undefined);
		if (!isActionIndexed) {
			let vo;
			vo={};
			vo[key]=mode;
			await cl.createIndex(vo);
		}
	}catch(err){
		console.error(err);
	}
};


module.exports = MongoDB;