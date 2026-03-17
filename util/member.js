let config={
	"GUEST":{
		codeName:"GUEST",
		level:0,
		name:"Guest",
		names:{
			EN:"Guest",
			CN:"访客",
		},
		price:{daily:0},
		maxDiskNum:0,
		maxDiskSize:0,
		txtMaxDiskSize:"0K",
		maxDiskFileNum:0,
		privateDisk:false,
		aliasUniverse:false,
		sharePackage:false,
		universes:[],
		backupUniverse:0,
		shareFlask:false,
		loginGas:50,
	},
	"MEMBER":{
		codeName:"MEMBER",
		level:1,
		name:"Free Member",
		names:{
			EN:"Free Member",
			CN:"免费会员",
		},
		price:{daily:0},
		maxDiskNum:3,
		maxDiskSize:500*1024,
		txtMaxDiskSize:"500K",
		maxDiskFileNum:100,
		privateDisk:false,
		aliasUniverse:false,
		sharePackage:true,
		universes:["sandbox1","sandbox2"],
		backupUniverse:0,
		shareFlask:true,
		loginGas:100,
	},
	"PRIME":{
		codeName:"PRIME",
		level:2,
		name:"Prime Member",
		names:{
			EN:"Prime Member",
			CN:"初级会员",
		},
		price:{
			daily:0,
			package:{
				"PrimePoints":{
					codeName:"PrimePoints",
					days:0,
					name:"Unlock Prime by Gas",
					names:{
						EN:"Unlock Prime by Gas",
						CN:"能量解锁"
					},
					oneTimeOnly:true,
					cost: {
						type:"points",
						num:1000,
						points: 1000,
					}
				},
				"PrimeCoins":{
					codeName:"PrimeCoins",
					days:0,
					name:"Unlock Prime by Token",
					names:{
						EN:"Unlock Prime by Token",
						CN:"金币解锁"
					},
					oneTimeOnly:true,
					cost: {
						type:"coins",
						num:10,
						coins: 10,
					}
				},
			}
		},
		maxDiskNum:20,
		maxDiskSize:5*1024*1024,
		txtMaxDiskSize:"5M",
		maxDiskFileNum:1000,
		privateDisk:true,
		aliasUniverse:true,
		sharePackage:true,
		universes:["sandbox1","sandbox2","sandbox3","sandbox4","sandbox5"],
		backupUniverse:1,
		shareFlask:true,
		loginGas:200,
	},
	"PRO":{
		codeName:"PRO",
		level:3,
		name:"Pro Member",
		names:{
			EN:"Pro Member",
			CN:"专业会员",
		},
		price:{
			daily:1,
			package:{
				"ProBetaPoints":{
					codeName:"ProBetaPoints",
					days:30,
					name:"Pro Member Beta 30 Days by Gas",
					names:{
						EN:"Pro Beta",
						CN:"内测专享"
					},
					oneTimeOnly:true,
					userFlag:"MemberProBeta",
					cost: {
						type:"points",
						num:1000,
						points: 1000,
					}
				},
				"ProBetaCoins":{
					codeName:"ProBetaCoins",
					days:30,
					name:"Pro Member Beta 30 Days by Token",
					names:{
						EN:"Pro Beta",
						CN:"内测专享"
					},
					oneTimeOnly:true,
					userFlag:"MemberProBeta",
					cost: {
						type:"coins",
						num:3,
						coins: 3,
					}
				},
				"Pro30":{
					codeName:"Pro30",
					days:30,
					name:"Pro Member 30 Days",
					names:{
						EN: "30 Days",
						CN: "30 天",
					},
					cost: {
						type:"coins",
						num:30,
						coins: 30
					}
				},
				"Pro100":{
					codeName:"Pro100",
					days:100,
					name:"Pro Member 100 Days",
					names:{
						EN: "100 Days",
						CN: "100 天",
					},
					cost: {
						type:"coins",
						num:80,
						coins: 80,
					}
				},
				"Pro365":{
					codeName:"Pro365",
					days:365,
					name:"Pro Member 365 Days",
					names:{
						EN: "365 Days",
						CN: "365 天",
					},
					cost: {
						type:"coins",
						num:200,
						coins: 200,
					}
				},
			}
		},
		maxDiskNum:100,
		maxDiskSize:100*1024*1024,
		txtMaxDiskSize:"200M",
		maxDiskFileNum:5000,
		privateDisk:true,
		aliasUniverse:true,
		sharePackage:true,
		universes:[
			"sandbox1","sandbox2","sandbox3","sandbox4","sandbox5","sandbox6","sandbox7","sandbox8","sandbox9","sandbox10",
		],
		backupUniverse:5,
		shareFlask:true,
		loginGas:500,
	},
	"ELITE":{
		codeName:"ELITE",
		level:4,
		name:"Elite Member",
		names:{
			EN:"Elite Member",
			CN:"精英会员",
		},
		price:{
			daily:5,//coins
			package:{
				"Elite30":{
					codeName:"Elite30",
					days:30,
					name:"30 Days",
					names:{
						EN: "30 Days",
						CN: "30 天",
					},
					cost: {
						type:"coins",
						num:150,
						coins: 150,
					},
				},
				"Elite100":{
					codeName:"Elite100",
					days:100,
					name:"100 Days",
					names:{
						EN: "100 Days",
						CN: "100 天",
					},
					cost: {
						type:"coins",
						num:400,
						coins: 400,
					}
				},
				"Elite365":{
					codeName:"Elite365",
					days:365,
					name:"365 Days",
					names:{
						EN: "365 Days",
						CN: "365 天",
					},
					cost: {
						type:"coins",
						num:1000,
						coins: 1000,
					}
				}
			}
		},
		maxDiskNum:500,
		maxDiskSize:500*1024*1024,
		txtMaxDiskSize:"500M",
		maxDiskFileNum:5000,
		privateDisk:true,
		aliasUniverse:true,
		sharePackage:true,
		universes:[
			"sandbox1","sandbox2","sandbox3","sandbox4","sandbox5","sandbox6","sandbox7","sandbox8","sandbox9","sandbox10",
			"sandbox11","sandbox12","sandbox13","sandbox14","sandbox15","sandbox16","sandbox17","sandbox18","sandbox19","sandbox20",
		],
		backupUniverse:50,
		shareFlask:true,
		loginGas:1000,
	},
	"LORD":{
		level:1024,
		name:"Lord",
		names:{
			EN:"Lord",
			CN:"主宰",
		},
		maxDiskNum:500,
		maxDiskSize:2048*1024*1024,
		txtMaxDiskSize:"2G",
		maxDiskFileNum:50000,
		privateDisk:true,
		aliasUniverse:true,
		sharePackage:true,
		universes:[
			"sandbox1","sandbox2","sandbox3","sandbox4","sandbox5","sandbox6","sandbox7","sandbox8","sandbox9","sandbox10",
			"sandbox11","sandbox12","sandbox13","sandbox14","sandbox15","sandbox16","sandbox17","sandbox18","sandbox19","sandbox20",
		],
		backupUniverse:100,
		shareFlask:true,
		loginGas:1000,
	},
};

let gasMenu={
	disk:{
		"checkIn": 20,
		"checkOut": 0,
		"addMember": 20,
		"removeMember": 20,
		"setup": 20,
	},
	package:{
		"share":200,
	},
	project:{
		"init":20,
	}
};

module.exports= {
	isVIP:function(rank){
		switch(rank){
			case "PRIME":
			case "PRO":
			case "ELITE":
			case "LORD":
				return true;
		}
		return false;
	},
	isVVIP:function(rank){
		switch(rank){
			case "PRO":
			case "ELITE":
			case "LORD":
				return true;
		}
		return false;
	},
	config:config
};