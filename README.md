# [am-check-in](https://github.com/amclubs/am-check-in)
这是一个用来机场自动签到免费领取流量的自动脚本，一份代码支持多种运行环境，支持GitHub Actions、支持 Cloudflare Workers 和 Pages平台 的自动签到脚本，释放你的双手出去City Walk

本仓库在原版基础上做了几处增强：
- **WorkBuddy 每日签到领积分**：配置 `WB_TOKEN`、`WB_UID` 后，机场签到和 WorkBuddy 签到会在同一次任务里各自执行，结果合并成一条 TG 通知。两者可以只配其中一个。
- **先查后签，当天只签一次**：机场先通过 `/getuserinfo` 判断今天是否已签（按北京时间），已签就不再调签到接口；WorkBuddy 先查签到状态再领取。
- **当天已签则静默**：定时任务一天跑多次，如果所有启用的签到都已完成且没有失败，本次不发 TG 通知，只写运行日志。第一次签到成功或任何一路失败才会发通知。
- **通知带余量信息**：机场显示本次获得、剩余流量、今日已用、套餐到期日；WorkBuddy 显示本次积分、连签天数、签到累计积分。示例：

```
执行时间: 2026-09-27 08:00:12
🎉 签到结果
🛫 机场：本次 +100 MB ｜ 剩余 97.1GB ｜ 今日已用 1.2GB ｜ 2026-10-30 到期
🐱 WorkBuddy：本次 +100 积分 ｜ 连签 3 天 ｜ 签到累计 300 积分
```

机场剩余流量来自 SSPanel 的 `/gettransfer`，到期日来自 `/getuserinfo`；如果面板不提供这些接口，会自动退化为只显示签到结果。WorkBuddy 没有账户积分余额接口，“签到累计”是本活动周期内签到累计的积分。

#
- [部署视频教程](https://youtu.be/b7AI447ZnuA)

## 一、GitHub Actions使用方法
- 项目地址: https://github.com/amclubs/am-check-in
### ① 复制仓库代码
1. 把当前github的项目能过 use this template 复制创建到你的创建里。
### ② 设置 GitHub Actions 变量
1. Settings -> secrets and variables -> Actions -> Secrets -> New repository secrets
2. 设置对应的变量参数 DOMAIN、USERNAME、PASSWORD （详情参数看下面变量说明）
3. (可选)设置TG通知参数 TG_TOKEN、TG_ID （详情参数看下面变量说明）
### ③ 设置定时任务时间
1. 进入代码.github/workflows -> check-in-job.yml 
2. 修改定时任务时间 cron (推荐修改成其它时间)
~~~
on:
  schedule:
    - cron: '0 0 * * *'  # 每天 00:00 UTC 执行，调整为你需要的时间
  workflow_dispatch:  # 允许手动触发
~~~

## 二、Cloudflare使用方法
- 项目代码:  https://github.com/amclubs/am-check-in/_worker.js
- 示例项目地址: `jc.amclubs.workers.dev`；
### ① 登录CF帐号，创建对应Workers & Pages项目，把 [_worker.js](https://github.com/amclubs/am-check-in/_worker.js) 代码部署上去
### ② 设置 CF 变量
1. 设置对应的变量参数 DOMAIN、USERNAME、PASSWORD （详情参数看下面变量说明）
2. (可选)设置TG通知参数 TG_TOKEN、TG_ID （详情参数看下面变量说明）
### ③ 检查TG通知是否配置成功
- 访问`https://jc.amclubs.workers.dev/tg`；
### ④ 手动签到
1. 示例TOKEN变量值: `auto`
2. 访问`https://jc.amclubs.workers.dev/auto`；
### ⑤ 设置自动签到
1. **设置** > **触发事件** > **＋添加** > **Cron 触发器**；
2. **一周中的某一天** > **每天** > **00:00**(推荐修改成其它时间) > **添加** 即可；

## 三、变量说明
| 变量名 | 示例 | 必填 | 备注 | 
|--|--|--|--|
| `DOMAIN` | `xxx.com` |✅| 机场域名 |
| `USERNAME` | `xx@xx.com` |✅| 机场账户邮箱 |
| `PASSWORD` | `pwd` |✅| 机场账户密码 |
| `TOKEN` | `auto` |❌|自动签到变量 |
| `TG_TOKEN` | `6901234567:XXXXXXXXXX0qExxxhHxxbXXX` |❌| 发送TG通知机器人的token | 
| `TG_ID` | `6901234567` |❌| 接收TG通知的账户ID | 
| `TG_API` | `https://api.telegram.org` |❌| Telegram API 地址，默认即可，仅测试时改 |
| `WB_TOKEN` | `eyJhbGciOi...` |❌| WorkBuddy 登录令牌 accessToken，配置后启用 WorkBuddy 签到 |
| `WB_UID` | `123456` |❌| WorkBuddy 用户 ID，启用 WorkBuddy 签到时必填 |
| `WB_ENTERPRISE_ID` | `ent_xxx` |❌| WorkBuddy 企业账号的 enterpriseId，个人账号留空 |
| `WB_DOMAIN` | | ❌| 会话文件里的 `auth.domain`，一般留空 |
| `WB_ENDPOINT` | `https://copilot.tencent.com` |❌| WorkBuddy 服务端地址，默认即可 |

机场三个变量（`DOMAIN`、`USERNAME`、`PASSWORD`）和 WorkBuddy 两个变量（`WB_TOKEN`、`WB_UID`）至少配置一组。

## 三点五、WorkBuddy 签到说明
WorkBuddy 签到走的是桌面端逆向出来的接口（参考 [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin)），不是账号密码登录，需要把桌面端的登录令牌复制到变量里：

**推荐：用 CodeBuddy CLI 登录拿明文令牌**（macOS 实测可用，Linux 同理）

1. 安装并登录 CLI：`npm install -g @tencent-ai/codebuddy-code`，然后运行 `codebuddy`，首次启动会引导浏览器授权登录。
2. 登录后凭据文件在：
   - macOS：`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info`
   - Linux：`~/.local/share/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info`
3. 文件是 JSON，取 `auth.accessToken` 填到 `WB_TOKEN`，取 `account.uid` 填到 `WB_UID`；如果 `account.enterpriseId` 有值，填到 `WB_ENTERPRISE_ID`。

**不推荐：WorkBuddy 桌面端的会话文件** `workbuddy-desktop.info`（同目录）。新版桌面端会把 `auth.accessToken` 加密成 `{"$wbEncrypted":1,...}`，无法直接使用；这种情况下改用上面的 CLI 方式，或直接在本机跑参考项目。

注意事项：
- 客户端会定期刷新令牌，令牌失效后签到会返回 401，TG 通知里会提示“令牌已失效”，此时重新复制一次 `WB_TOKEN` 即可。
- 脚本先查签到状态，未签才领取，重复运行不会多领；签到活动未开启时会直接汇报。
- 接口随时可能被腾讯调整，失效属正常现象。

本地跑测试：`npm test`（Node 18+）。

## 四、Telegram获取token 和chat_id 的方式
### 1、加入 BotFather 机器人
点击网址https://t.me/BotFather ，打开与它的聊天界面。

### 2、创建 bot 并获取 token
- 2.1 创建机器人
输入 /newbot 回车
显示：Alright, a new bot. How are we going to call it? Please choose a name for your bot.

- 2.2 输入机器人的名称
比如输入 acmlubs_bot 回车
显示：Good. Now let’s choose a username for your bot. It must end in bot. Like this, for example: TetrisBot or acmlubs_bot.

- 2.3 输入唯一的机器人用户名
格式为 acmlubs_bot 或 acmlubsbot 必须以bot结尾。
失败后显示：Sorry, xxxxxxxxxx
成功后显示：
Done! Congratulations on your new bot. You will find it at t.me/acmlubs_bot. You can now add a description, about section and profile picture for your bot, see /help for a list of commands. By the way, when you’ve finished creating your cool bot, ping our Bot Support if you want a better username for it. Just make sure the bot is fully operational before you do this.

Use this token to access the HTTP API:
5xxx337:AAxxx3ApRGg
Keep your token secure and store it safely, it can be used by anyone to control your bot.

- 2.4 提取token
2.3中HTTP API 下面一行就是需要的token。

### 3、获取chat_id
- 3.1先测试一下
浏览器中输入：https://api.telegram.org/bot{token}/getUpdates 回车
其中：{token}为2.4中获取的token，包括大括号。
显示：{
“ok”: true,
“result”: []
}
如果显示error，说明有错误。

- 3.2 获取chat_id
- 3.2.1 在你生成的机器人中（本例为acmlubs_bot的机器人）随意输入一个词语，比如“Hello World”。如果获取群的，把（本例为acmlubs_bot的机器人）加入群，然后在群里发 hello @amclubs_bot 信息
- 3.2.2 重新在浏览器中输入https://api.telegram.org/bot{token}/getUpdates
其中：{token}为2.4中获取的token，包括大括号。
- 3.2.3 在显示的ok页中找到”chat”: {“id”: 1234567，”first_name”…….其中id后的数字即为需要的chat_id(如果是群的chat_id是负数来的)。

- 3.3 curl 测试一下获取到的taken和chat_id
在vps中输入命令

curl -s -X POST https://api.telegram.org/bot{token}/sendMessage -d chat_id={chatId} -d text="Hello World"
其中：{token}、{chatId}分别为获取的token和chatid，包括大括号。

- 3.4 成功与否
Telegrame客户端中的acmlubs_bot收到”Hello World”，就成功了！


![check-in](https://raw.githubusercontent.com/amclubs/am-check-in/main/check-in.jpg)
  
 </details></center>

 #
 免责声明:
 - 1、该项目设计和开发仅供学习、研究和安全测试目的。请于下载后 24 小时内删除, 不得用作任何商业用途, 文字、数据及图片均有所属版权, 如转载须注明来源。
 - 2、使用本程序必循遵守部署服务器所在地区的法律、所在国家和用户所在国家的法律法规。对任何人或团体使用该项目时产生的任何后果由使用者承担。
 - 3、作者不对使用该项目可能引起的任何直接或间接损害负责。作者保留随时更新免责声明的权利，且不另行通知。
