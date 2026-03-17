const  spawn =require('child_process').spawn;
const child_process = require("child_process");

module.exports={
	sendTextMail:async function(title,content,tgtAddress,frmAddress){
		child_process.exec(`echo ${JSON.stringify(content)} | mail -s "${title}" -r ${frmAddress||"noreply@cokecodes.com"} ${tgtAddress}`,{});
	},
	sendHtmlEmail:function(from, to, subject, htmlContent) {
		return new Promise((resolve, reject) => {
			const sendmail = spawn('sendmail', ['-t']);
			
			// 构造完整邮件内容
			const message = [
				`From: ${from}`,
				`To: ${to}`,
				`Subject: ${subject}`,
				`MIME-Version: 1.0`,
				`Content-Type: text/html; charset=UTF-8`,
				``,
				htmlContent
			].join('\n');
			
			// 监听发送结果
			sendmail.stdin.write(message);
			sendmail.stdin.end();
			
			sendmail.on('exit', (code) => {
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(`sendmail exited with code ${code}`));
				}
			});
			
			sendmail.on('error', (err) => {
				reject(err);
			});
		});
	}
};


