# 桌面开发模拟服务

在 `dsh-pet/` 包目录安装依赖并构建桌面共享核心：

```sh
pnpm install --frozen-lockfile
npm run build:desktop-core
npm run ensure:electron
```

启动模拟服务，第二个参数选择余额形态，缺省为 `money`：

```sh
npm run dev:mock -- 8231 money
# 也可以使用 windows（额度窗口）或 points（积分）
```

另开一个终端启动桌面窗口：

```sh
npm run start:desktop -- http://127.0.0.1:8231/dsh-pet-7340/config
```

宠物启动后，在右键菜单中点击「查看余额」，或向 `http://127.0.0.1:8231/dsh-pet-7340/balance` 发送 POST 请求。金额场景显示 `¥11.06`，额度场景提供三种窗口的使用百分比和重置时间，积分场景显示 `800 积分`。

模拟服务通过 `GET /state` 提供状态，`POST /balance` 更新余额节点并唤醒长轮询；首次读取只建立基线，所以需要手动刷新来显示气泡。状态计数和等待参数校验复用宿主实现，字体、光标图片和动画从包内素材目录读取。

服务只读取包内默认配置与素材，不访问用户配置、聊天记录或服务商凭证，也不调用模型和真实余额接口。其他动作接口未模拟。脚本使用 Node 的 TypeScript 类型擦除来加载宿主状态存储，`npm run dev:mock` 已带所需参数；直接启动时使用 `node --experimental-strip-types scripts/dev/mock-server.mjs [port] [shape]`。

HTTP 与客户端解析链路的回归测试已纳入 `npm test`，也可以单独运行：

```sh
node --experimental-strip-types --import ./scripts/test-register.mjs --test src/host/dev-mock.test.ts
```
