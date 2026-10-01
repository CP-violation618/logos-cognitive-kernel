# LOGOS — 使用说明书

本文档是**操作手册**：怎么装、怎么用、每一层在做什么、什么时候该用哪一层、踩坑怎么办。

架构背后的**理由**（为什么这样设计、否掉了什么替代方案）在 [ARCHITECTURE.md](./ARCHITECTURE.md)。
本文只回答"我怎么用它"。

> **文档里的每一个代码示例都在 `test/guide.test.ts` 里跑过。**
> 这份重复是故意的：一本带未测试示例的手册，一个月内必然是错的。

---

## 目录

1. [安装与自检](#1-安装与自检)
2. [五分钟上手](#2-五分钟上手)
3. [心智模型：七层在干什么](#3-心智模型七层在干什么)
4. [第 0 层 · 内核](#4-第-0-层--内核)
5. [第 1 层 · 记忆](#5-第-1-层--记忆)
6. [第 2 层 · 注意门控](#6-第-2-层--注意门控)
7. [第 3 层 · 推理](#7-第-3-层--推理)
8. [第 4 层 · 目标与规划](#8-第-4-层--目标与规划)
9. [第 5 层 · 元认知](#9-第-5-层--元认知)
10. [第 6 层 · 技能](#10-第-6-层--技能)
11. [组装成一个完整智能体](#11-组装成一个完整智能体)
12. [接一个大模型](#12-接一个大模型)
13. [确定性、复现与调试](#13-确定性复现与调试)
14. [命令行](#14-命令行)
15. [常见陷阱](#15-常见陷阱)
16. [扩展与贡献](#16-扩展与贡献)
17. [API 速查](#17-api-速查)

---

## 1. 安装与自检

### 要求

**Node 22.18.0 或更高。** 不是 22.6。

类型擦除（type stripping）在 22.6.0 就存在，但**默认开启是 22.18.0**。在这个版本之前，直接 `node src/cli.ts` 会报：

```
TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"
```

这是本项目真实踩过的坑 —— README 曾声称 22.6+，而 CI 在真实 Node 22.6 上跑挂了。现在 CI 会**精确测试声明的下限**，并且有测试保证所有文档里的版本声明一致。

### 装

```bash
git clone https://github.com/CP-violation618/logos-cognitive-kernel.git
cd logos-cognitive-kernel
npm install --include=dev
```

`--include=dev` **不能省**。如果你的机器 npm 配置里有 `omit=dev`（很多国内镜像配置默认带），`npm install` 会显示 "up to date" 然后**什么都不装**，于是类型检查静默跳过。这就是为什么 CI 里也强制加了这个参数。

**没有构建步骤。** 源码就是运行产物，`node src/cli.ts` 直接跑 `.ts`。

### 自检

```bash
npm run verify     # 类型检查 + 全部测试 + 示例，三者全过才退出 0
```

单独跑：

```bash
npm test                        # 701 个测试
npx tsc --noEmit                # 类型检查
node examples/quickstart.ts     # 一步步的教学演示
node src/cli.ts demo            # 端到端认知场景
```

如果 `npm run verify` 通过，你的环境就是对的。

---

## 2. 五分钟上手

一个能跑的最小认知体 —— 只有内核和记忆：

```ts
import { Kernel } from 'logos-cognitive-kernel';
import { WorkingMemory } from 'logos-cognitive-kernel/memory';

const kernel = new Kernel({ config: { seed: 0x5eed } });
await kernel.start();

const working = new WorkingMemory({ capacity: 7 });
working.encode('the client wants the report by Friday', { salience: 0.9 });
working.encode('lunch is at noon', { salience: 0.2 });

// 注意力是竞争，不是过滤：用目标给它加偏置
working.prime('deadline and deliverables', 1);

for (const item of working.focused()) {
  console.log(item.activation.toFixed(3), item.content);
}

await kernel.stop();
```

你会看到"报告"那条排在"午饭"前面 —— 即使它俩的初始显著度差距不大。

想看完整能力，跑 `node src/cli.ts demo`，它会打印一个有目标的智能体经历 44 个认知周期、形成概念、采取行动、并给自己打校准分的全过程。

---

## 3. 心智模型：七层在干什么

每一层只依赖**下面**的层，跨层通信只走事件总线。

```
6  skills         我能做什么 —— 练习让技能变便宜
5  metacognition  我做得好不好 —— 校准与自我模型
4  planning       我想要什么，怎么得到
3  reasoning      什么成立，我信什么
2  perception      什么进得来
1  memory         我持有什么、发生过什么、什么是真的
0  kernel         时间、事件、注意力预算、随机数
```

**用哪一层，取决于你的问题是什么：**

| 你的问题 | 用哪一层 |
|---|---|
| "这东西该记住吗？" | 1 memory |
| "这条信息值得注意吗？" | 2 perception |
| "这会发生吗？我该信这个吗？" | 3 reasoning |
| "我怎么达成这个目标？" | 4 planning |
| "我刚才想得对吗？" | 5 metacognition |
| "这件事我做过吗？" | 6 skills |

**一个关键约定**：所有层共享一个 `Kernel`。内核提供时钟、总线、调度器和随机数生成器 —— **不要自己 new 时钟**，否则时间线会对不上，记忆的衰减会和调度器脱节。

---

## 4. 第 0 层 · 内核

内核提供四样东西：**逻辑时钟、事件总线、预算调度器、种子随机数**。

### 启动与子系统

```ts
const kernel = new Kernel({ config: { seed: 0x5eed } });
const seen: string[] = [];

kernel.use({
  name: 'greeter',
  start: (context) => {
    context.bus.on('kernel:started', () => seen.push('hello'));
  },
});

await kernel.start();
console.log(kernel.describe());   // logos[running] tick=0 subsystems=1 events=2 pending=0
await kernel.stop();
```

`subsystem` 就是任何有 `name` 和 `start` 的对象。它是接入生命周期钩子最轻的方式。

### 工作是"被调度"的，不是"被等待"的

这是最容易用错的地方。**不要 `await` 一个长任务**，把它交给调度器：

```ts
let step = 0;
const task = kernel.scheduler.enqueue<number>({
  name: 'deliberate',
  priority: 100,
  run: () => {
    step += 1;
    if (step < 3) return { status: 'yielded', detail: `phase ${step}` };
    return { status: 'done', value: step };
  },
});

for (let i = 0; i < 4; i += 1) await kernel.tick();
const settled = await task.settled;
console.log(settled.state, settled.value);   // done 3
```

**`yielded` 的含义是"这次思考只能到这儿，下个 tick 再来接我"。** 这是把深思分散到多个周期、而不是让一次思考吃掉整个 tick 的机制。

注意 `settled.state`（不是 `.status`）—— 取值是 `'done' | 'failed' | 'cancelled'`。

调度器有**每 tick 预算**，而且同一个任务在一个 tick 内不会被重复录取。任务可以被抢占、被取消、被结算。

### 确定性

```ts
const draws = async (seed: number): Promise<number[]> => {
  const k = new Kernel({ config: { seed } });
  await k.start();
  const out: number[] = [];
  for (let i = 0; i < 4; i += 1) out.push(k.rng.next());
  await k.stop();
  return out;
};

await draws(1234);   // 永远相同
await draws(9999);   // 与上面不同
```

**两个方向都必须成立。** 只测"同种子一致"没有意义 —— 如果代码里根本没有随机性，它也会通过。CI 里两个方向都测。

**永远不要用 `Math.random()`。** 有一个测试会扫描 `src/` 并在发现时失败。

---

## 5. 第 1 层 · 记忆

四个存储，各管一件事：

| 存储 | 管什么 | 类比 |
|---|---|---|
| `WorkingMemory` | 此刻在想的（约 7 个槽） | 意识 |
| `EpisodicMemory` | 发生过什么 | 自传体记忆 |
| `SemanticMemory` | 什么是真的 | 概念知识 |
| `Rememberer` | 一次检索四个存储 | 回忆 |

### 工作记忆：容量是硬上限

```ts
const working = new WorkingMemory({ capacity: 3 });
working.encode('the client wants the report by Friday', { salience: 0.9 });
working.encode('staging is on the old schema', { salience: 0.7 });
working.encode('lunch is at noon', { salience: 0.2 });
working.encode('the build is red again', { salience: 0.6 });

console.log(working.size);   // <= 3
```

容量是**上限不是建议**。装不下时最弱的会被挤出去。

**复述会延长半衰期**（间隔效应）：

```ts
const { id } = working.encode('the migration is scheduled for Friday', { salience: 0.8 });
const before = working.get(id, { reinforce: false })?.halfLife ?? 0;

working.encode('the migration is scheduled for Friday', { salience: 0.8 });
const after = working.get(id, { reinforce: false })?.halfLife ?? 0;

console.log(after > before);   // true —— 被复述过的记忆衰减得更慢
```

注意 `{ reinforce: false }`：查一次不加权。默认的 `get()` 会强化，这在写探针时是个陷阱。

**启动（priming）改变竞争结果**：

```ts
working.prime('database schema migration', 1);
working.focused()[0];   // 与 database 相关的那条浮上来了
```

### 情景记忆：记录经历，且**回忆会改写它**

```ts
const episodic = new EpisodicMemory({ baseHalfLife: 400 });

const { id } = episodic.encode('the deploy failed on a Friday', {
  situation: 'deploy',
  context: { service: 'payments' },
  surprise: 0.6,
  affect: { valence: -0.4, arousal: 0.6 },
  data: { severity: 'high' },
});

const before = episodic.get(id)?.strength ?? 0;
episodic.retrieve(id, { context: { reviewedDuring: 'postmortem' } });
const after = episodic.get(id);

console.log(after.strength > before);              // true —— 检索让它更强
console.log(after.context.reviewedDuring);         // 'postmortem' —— 且掺进了当下
```

**这是再巩固（reconsolidation）**：回忆不是读取，是**重写**。记忆同时变得更强和更不忠实。每次检索都会把当前语境折进过去。

这不是缺陷，是特性 —— 但它意味着你不能把情景记忆当成不可变的审计日志。需要审计日志请用事件总线。

**遗忘需要两个条件同时满足**：强度低于阈值**且**保护期已过。只满足一个不会忘。保护期有下限和上限（10 ~ 512），防止一条记忆刚写下就被抹掉。

### 语义记忆：概念从重复经历中长出来

不要手写概念，让**巩固引擎**从情景里提取：

```ts
const kernel = new Kernel();
const episodic = new EpisodicMemory({ baseHalfLife: 400 });
const semantic = new SemanticMemory({ baseHalfLife: 4_000 });

const texts = [
  'the payment gateway timed out during the morning peak',
  'the payment gateway timed out when traffic doubled',
  'the payment gateway timed out while the cache was cold',
];
for (const [i, text] of texts.entries()) {
  episodic.encode(text, { situation: `incident-${i}`, surprise: 0.7 });
  episodic.advance(5);
}

const engine = new ConsolidationEngine({
  clock: kernel.clock,
  bus: kernel.bus,
  scheduler: kernel.scheduler,
  config: { ...kernel.config, memory: { ...kernel.config.memory, consolidationAgeTicks: 1 } },
  rng: kernel.rng,
  episodic,
  semantic,
});

const outcome = engine.consolidateNow();
console.log(outcome.conceptsFormed, outcome.conceptsReinforced);
console.log(episodic.size);   // 3 —— 泛化不会抹掉原始经历
```

`consolidationAgeTicks` 默认是 40（对活的智能体是诚实值）。演示里调低只是不想模拟几千个 tick。

**概念的 `grounding` 是"有多少条*不同*情景支持它"。** 同一条情景反复观察**不会**增加 grounding —— 重复而无变化不是知识。这条规则有专门的测试钉住。

### 统一检索：一次问，四个存储一起答

```ts
const rememberer = new Rememberer({
  working, episodic, semantic,
  rng: kernel.rng,
  now: () => kernel.clock.current,
});

const memory = rememberer.recall({ text: 'payment gateway timeout', limit: 5 });

console.log(memory.considered);   // 各存储考虑了多少条
for (const item of memory.items) {
  console.log(item.relevance, item.store, item.trace.content);
  // item.via === 'spreading' 时，item.path 显示它是怎么被激活过来的
}
```

`recall()` 会做**扩散激活**：一条被直接命中的记忆会激活与它关联的东西，即使那些东西和查询没有词面重叠。

**心情会影响检索结果** —— 但它作用于记忆的**情感内容**，所以对中性材料无效。这是正确行为不是缺陷：给中性记忆加情绪偏置本身就没有意义。

---

## 6. 第 2 层 · 注意门控

门控决定**什么进得来**。它不是一个滤波器，是一次**加权的竞争**。

```ts
const gate = new PerceptionGate({
  clock: kernel.clock, bus: kernel.bus,
  config: kernel.config, rng: kernel.rng,
  working, threshold: 0.3,
});

const first = gate.perceive({
  content: 'the primary database has stopped accepting writes',
  modality: 'text', source: 'monitor', intensity: 0.8,
});
console.log(first.admitted);   // true

// 同一件平淡的事反复来，就进不来了
for (let i = 0; i < 12; i += 1) {
  gate.perceive({ content: 'heartbeat ok', modality: 'text', source: 'monitor', intensity: 0.05 });
  gate.step();
}
const decision = gate.perceive({ content: 'heartbeat ok', modality: 'text', source: 'monitor', intensity: 0.05 });
console.log(decision.admitted, decision.reason);   // false 'habituated'
```

**习惯化是为什么一个心智可以忽略时钟。** 而且习惯化**只在刺激缺席时恢复** —— 一直响的警报会一直被忽略，这既是特性（不疯掉）也是风险（漏掉真警报）。用 `gate.dishabituate(content, source)` 手动重置。

`decision.reason` 的取值：`''`（进了）、`'below-threshold'`、`'habituated'`、`'saturated'`。

**每个决策都能解释自己**：

```ts
const d = gate.perceive({ content: 'a completely unprecedented event has occurred', modality: 'text', source: 'world', intensity: 1 });

d.percept.salience;            // 综合显著度
d.percept.terms.surprise;      // 各分项
d.percept.terms.novelty;
d.percept.terms.habituation;   // 习惯化乘子
```

五个加权项：`surprise .35` / `novelty .25` / `relevance .20` / `intensity .10` / `affect .10`。

**关键设计**：显著度是**意外**而不是**强度**。一个每天响一百次的警报，无论多"强烈"都会变得不显著 —— 这正是应该的。

**让世界模型参与**，`surprise` 项才有真实依据：

```ts
gate.setPredictor(world);
```

不设预测源时，`surprise` 项退化为中性值。

---

## 7. 第 3 层 · 推理

### 世界模型：学转移，量意外

```ts
const world = new WorldModel({ clock: kernel.clock, bus: kernel.bus, rng: kernel.rng });

for (let i = 0; i < 6; i += 1) {
  world.observe({ content: 'cache cold', source: 'monitor' });
  world.observe({ content: 'latency high', source: 'monitor' });
}

world.expect('cache cold', 3);    // 后继状态，带概率
world.predict(2);                 // 往前推两步
world.surpriseOf({ content: 'the datacentre is on fire', source: 'monitor', modality: 'text' });
```

**`surpriseOf` 在返回值上有讲究**：如果当前状态**没有任何转移记录**，它返回 `undefined` 而不是硬编一个数字。因为"我不知道"和"我预期它不会发生"是两回事，混为一谈会让门控在陌生情境里做出错误判断。

**平滑参数默认 0.25**，是量出来的不是拍的。观测一次之后不应该得到概率 1.0 —— 那等于宣称绝对确定。

### 信念：对数几率，可撤销

```ts
const beliefs = new BeliefStore({ clock: kernel.clock, bus: kernel.bus });
const P = 'the gateway is overloaded';

beliefs.declare(P);
const before = beliefs.get(P)?.credence ?? 0;      // 0.5

const belief = beliefs.addEvidence(P, {
  content: 'error rate rose with traffic',
  source: 'metrics',
  strength: 4,          // 似然比 >= 1
  reliability: 0.9,     // 来源可信度 [0,1]
});

const after = beliefs.get(P)?.credence ?? 0;       // 上升
```

> ### ⚠️ 这里有个必须知道的 API 细节
>
> **`addEvidence` 返回的是 `Belief`，它的 `.id` 是*命题*的 id，不是证据的 id。**
>
> 证据 id 在 `belief.evidence[0].id`。
>
> ```ts
> const belief = beliefs.addEvidence(P, { content: '...', source: 'metrics' });
> const evidenceId = belief.evidence[0].id;   // ✅ 这是证据 id
> // belief.id                                // ❌ 这是信念 id
> ```
>
> 早先版本里传错会**静默失效**：`retract` 返回原值、不报错、什么都不改。现在传错会抛 `LogosError`，并告诉你正确的 id 在哪。

**撤销是信念修正的另一半**，也是多数系统省略的那一半：

```ts
beliefs.retract(P, evidenceId);
console.log(beliefs.get(P)?.credence);   // 精确回到 0.5
```

实现上是**从剩余证据整体重算**，而不是减去一个增量。所以撤销后恢复的状态，和"那条证据从未出现过"完全一致。

**证据顺序不影响结论**：

```ts
// 无论按什么顺序加入强度 1,2,3,4 的证据，最终 credence 完全相同
```

这是通过对**规范序**（按来源、再按 id 排序）重算实现的，不是靠增量累加。增量累加是有顺序依赖的 —— 这一点曾经是 bug。

**多条证据来自同一来源时会打折**，防止同一份信息的多次转述被当成多次独立证实。

**可靠性只做阻尼，不做反转**：一个不可靠的来源说"P"，不构成"非 P"的证据。它只是推不动。

**信念之间可以建立推理链**：

```ts
beliefs.link('the gateway is overloaded', 'latency is high', { kind: 'supports', weight: 0.6 });
beliefs.propagate();   // 让支持关系传导
```

---

## 8. 第 4 层 · 目标与规划

### 目标：优先级是算出来的

```ts
const goals = new GoalSystem({ clock: kernel.clock, bus: kernel.bus, beliefs });

const small = goals.declare('water the plants', { utility: 0.2, feasibility: 0.9 });
const big = goals.declare('restore the payment service', { utility: 0.95, feasibility: 0.7 });

console.log(big.priority > small.priority);   // true
```

优先级公式：`0.45·效用 + 0.25·可行性 + 0.30·紧迫度 + 沉没成本`。

可选项：`parent`（分解成子树）、`deadline`、`notBefore`、`requires`、`conflictsWith`、`composition`。

**放弃一个目标必须给出理由，而且要记录当时的算术**：

```ts
goals.abandon(id, 'feasibility fell below the floor after three failed plans');
```

状态：`pending` / `active` / `achieved` / `failed` / `abandoned` / `suspended`。

`setFeasibility()` 让目标学会"这比看起来难" —— 规划失败时自动调用，而不是无限重试。

### 规划：HTN，不是动作序列搜索

规划器接受的输入是**任务分解方法**，不是"从当前状态搜到目标状态"。

```ts
const planner = new Planner({ clock: kernel.clock, bus: kernel.bus });

planner.defineAction({
  name: 'raise-pool',
  description: 'increase the connection pool size',
  effects: [{ key: 'pool', set: 'large' }],
  cost: 1,
});

planner.defineAction({
  name: 'restart-service',
  preconditions: [{ key: 'pool', equals: 'large' }],
  effects: [{ key: 'service', set: 'healthy' }],
  cost: 2,
});

planner.defineMethod({
  name: 'recover-with-pool',
  task: 'restore the service',
  actions: ['raise-pool', 'restart-service'],
});

const outcome = planner.plan('restore the service', {});
if (outcome.ok) {
  console.log(outcome.plan.steps.map((s) => s.action.name));
  // ['raise-pool', 'restart-service']
}
```

**`Method` 二选一**：给 `subtasks`（复合任务，递归分解）或给 `actions`（原始动作序列）。给两个会报错。

多个方法可用于同一个任务时，`priority` 高的先试；不行就回溯试下一个。

**为什么 HTN 而不是动作序列搜索**：搜索是 `b^d`，分解是线性的。而且人类知识本来就更适合写成"怎么做这件事"而不是"什么状态转移合法"。

**失败时会说明原因，不是一个空对象**：

```ts
const outcome = planner.plan('do something never declared', {});
if (!outcome.ok) {
  console.log(outcome.failure.reason);    // 为什么失败
  console.log(outcome.failure.rejected);  // 试过哪些路线，各自为什么被拒
}
```

`Plan` 上的有用字段：`steps`、`confidence`、`cost`、`depth`（树的真实深度，不是根节点深度）、`alternatives`。

---

## 9. 第 5 层 · 元认知

这一层回答两个不同的问题：

- **校准**：我该多信这个置信度？
- **自模型**：凭我对自己的了解，我**该用什么方式**去想这件事？

### 校准：Brier 分解

```ts
const calibrator = new Calibrator({ clock: kernel.clock, bus: kernel.bus, minimumSamples: 4 });

// 一个说 90% 但对错各半的预测者
for (let i = 0; i < 20; i += 1) {
  const p = calibrator.predict(`claim ${i}`, 0.9, { domain: 'estimates' });
  calibrator.resolve(p.id, i % 2 === 0);
}

const report = calibrator.report('estimates');
report.bias;          // > 0 表示过度自信
report.skill;         // < 0 表示毫无技能
report.reliability;   // 校准曲线贴合度
report.resolution;    // 分辨能力

calibrator.adjustedConfidence(0.9, 'estimates');   // < 0.9，被打折了
```

**为什么三个数都要看** —— 这是最容易被单个"准确率"数字骗到的地方：

```ts
// 一个永远说 50% 的预测者，面对公平硬币
for (let i = 0; i < 40; i += 1) {
  const p = calibrator.predict(`coin ${i}`, 0.5, { domain: 'coins' });
  calibrator.resolve(p.id, i % 2 === 0);
}

calibrator.report('coins').bias;         // ≈ 0，完美校准
calibrator.report('coins').resolution;   // ≈ 0，什么都没说
```

**"永远说 50%"是完美校准且完全无用的。** 只看 reliability 会把它评为优秀预测者。所以 resolution 和 skill 必须一起报。

`calibrator.resolveWhere(predicate, wasCorrect)` 可以批量结算。

### 自模型：策略选择是测出来的，不是声明的

```ts
const self = new SelfModel({ clock: kernel.clock, bus: kernel.bus, evidenceThreshold: 3, attentionScale: 1 });

// 一种彻底但昂贵的方式
for (let i = 0; i < 20; i += 1) {
  self.observe({ strategy: 'gather', kind: 'diagnosis', succeeded: i < 18, confidence: 0.8, attention: 10, startedAt: tick(0) });
}
// 一种便宜且略差的方式
for (let i = 0; i < 20; i += 1) {
  self.observe({ strategy: 'recall', kind: 'diagnosis', succeeded: i < 16, confidence: 0.7, attention: 1, startedAt: tick(0) });
}

const rec = self.recommend({ kind: 'diagnosis', description: 'the pump is failing' });
console.log(rec.strategy);   // 'recall'
console.log(rec.reason);     // 说明是按每次尝试的注意力消耗算出来的
```

**选择依据是"效率"而不是"原始成功率"。** 90% 成功率但每次花 10 单位注意力，输给 80% 但只花 1 单位的。一个只按成功率排序的心智永远发现不了这件事。

**六种策略**：`recall` / `infer` / `gather` / `decompose` / `apply-skill` / `defer`。

`defer`（拒绝回答）是**一个真实的策略** —— 有时不回答就是对的，而这一点几乎没人建模。

**证据和启发式永不混合。** 有测量数据就按数据走；没有就退化到一条**明说的**启发式，并告诉你用的是哪条。一个悄悄稀释真实证据的启发式比两者都糟。

**故意不提供"智力分数"。** 一个总结心智的单一数字，恰恰是本项目要避免的东西：不可证伪、无法行动、而且好听。

**置信度会被自我调整**：

```ts
self.adjustConfidence(0.9, 'estimates');
```

自模型测出的偏差会被**减去**；校准器给出的是**目标值**，会被**趋近**。这两者搞混是个符号错误，后果很具体：一个告诉你"你过度自信，应该是 0.65"的校准器，曾被当成 -0.25 的偏差又减了一次，**结果是置信度上升** —— 被告知过度自信的心智反而更自信了。这是真实修过的 bug。

---

## 10. 第 6 层 · 技能

技能是**程序性记忆**：能做的事，以及做得有多熟。

```ts
const skills = new SkillRegistry({
  clock: kernel.clock, bus: kernel.bus, rng: kernel.rng,
  scheduler: kernel.scheduler,      // 可选：把练习计入注意力预算
});

skills.define({
  name: 'restart-service',
  achieves: 'the service is running',
  steps: [{ kind: 'action', name: 'stop' }, { kind: 'action', name: 'start' }],
  prior: 0.1,
});

const expensive = skills.costOf('restart-service');

const context = (): SkillContext => ({ act: () => true, state: {}, budget: 100 });
for (let i = 0; i < 40; i += 1) await skills.attempt('restart-service', context());

const cheap = skills.costOf('restart-service');
console.log(cheap < expensive);   // true
```

**练习让技能变便宜，不只是变好。** 这就是自动化（automatization）：掌握之后它不再需要"刻意"，于是节省下来的注意力可以给别的事。实测在默认参数下，掌握一个单步技能会把成本从 0.69 降到 0.15。

**掌握度下降比上升快** —— 成功可能是运气，失败通常不是。

### 前置条件失败 ≠ 能力不足

这是本层最重要的一条区分：

```ts
skills.define({
  name: 'drain-node',
  steps: [{ kind: 'action', name: 'cordon' }, { kind: 'action', name: 'evict' }],
  preconditions: [{ key: 'cluster', present: true }],
  prior: 0.8,
});

const before = skills.byName('drain-node')?.mastery ?? 0;
const attempt = await skills.attempt('drain-node', { act: () => true, state: {}, budget: 100 });
const after = skills.byName('drain-node')?.mastery ?? 0;

console.log(attempt.failure);   // 'preconditions-unmet'
console.log(after === before);  // true —— 什么都没变
```

**"我在这儿做不了"和"我不擅长这个"是两件事。** 把它们混为一谈，会教会一个心智去回避它其实擅长的事。所以前置条件不满足时，掌握度**不动**，也不消耗注意力。

`FailureKind` 四种：`preconditions-unmet`（不关能力）/ `execution-failed`（关能力）/ `malformed`（是缺陷不是失败）/ `interrupted`（不确定）。

### 技能可以组合

```ts
skills.define({
  name: 'deploy',
  steps: [
    { kind: 'action', name: 'build' },
    { kind: 'skill', name: 'restart-service' },          // 调用另一个技能
    { kind: 'branch', on: 'cacheCold',
      then: [{ kind: 'action', name: 'warm-cache' }],
      otherwise: [] },                                    // 条件分支
    { kind: 'repeat', times: 3, body: [{ kind: 'action', name: 'probe' }] },
  ],
});
```

**结构是免费的，工作是收费的。** `repeat` 和 `branch` 容器本身不扣注意力，只扣真正执行的动作。曾经把容器按工作收费，导致一个流程比它包含的步骤还贵。

**按目标反查技能**：

```ts
skills.forGoal('the service is running');   // 按掌握的熟练度排序
skills.isCompetent('restart-service');
```

---

## 11. 组装成一个完整智能体

`CognitiveAgent` 把七层接成一个循环：

**感知 → 定向 → 回忆 → 评估 → 深思 → 行动 → 预测 → 反思**

```ts
import { CognitiveAgent, type Environment } from 'logos-cognitive-kernel/cognition';

const kernel = new Kernel({ config: { seed: 7 } });
const working = new WorkingMemory({ capacity: 7 });
const episodic = new EpisodicMemory({ baseHalfLife: 400 });
const semantic = new SemanticMemory({ baseHalfLife: 4_000 });
const gate = new PerceptionGate({ clock: kernel.clock, bus: kernel.bus, config: kernel.config, rng: kernel.rng, working, threshold: 0.3 });
const rememberer = new Rememberer({ working, episodic, semantic, rng: kernel.rng, now: () => kernel.clock.current });
const consolidation = new ConsolidationEngine({ clock: kernel.clock, bus: kernel.bus, scheduler: kernel.scheduler, config: kernel.config, rng: kernel.rng, episodic, semantic });
const world = new WorldModel({ clock: kernel.clock, bus: kernel.bus, rng: kernel.rng });
const beliefs = new BeliefStore({ clock: kernel.clock, bus: kernel.bus });
const goals = new GoalSystem({ clock: kernel.clock, bus: kernel.bus, beliefs });
const planner = new Planner({ clock: kernel.clock, bus: kernel.bus });
const calibrator = new Calibrator({ clock: kernel.clock, bus: kernel.bus });

gate.setPredictor(world);   // 让 surprise 项有真实依据

const environment: Environment = {
  observe: () => ({}),                                        // 当前世界状态
  act: (name) => ({ name, succeeded: true, detail: 'done' }), // 执行一个动作
};

const agent = new CognitiveAgent({
  kernel, working, episodic, semantic, consolidation, rememberer,
  gate, world, beliefs, goals, planner, calibrator,
  environment,
  reflectEvery: 3,     // 每 3 个周期反思一次
  actAbove: 0.4,       // 低于这个置信度就不行动
});

await kernel.start();
const reports = await agent.run(12);
await kernel.stop();
```

### 三个必须知道的行为

**1. 省略 `environment` 就是一个纯思考的智能体** —— 它会规划但从不行动。

**2. 情景记忆只记录门控*录取*的东西，不记录"提供"的东西。**

```ts
await agent.run(3);
console.log(episodic.size);   // 0 —— 什么都没提供，所以什么都没记下

await agent.run(4, () => [
  { content: 'the primary database stopped accepting writes', modality: 'text', source: 'monitor', intensity: 1 },
]);
console.log(episodic.size);   // > 0 —— 意外的观察进来了，成了经历
```

这是正确的（没进意识的东西不该成为记忆），但初用时容易困惑：**`run()` 不给感知源，智能体就没有过去可以积累**，而巩固引擎会因为没有原料而空转。

**3. 一个周期不会勾掉一个目标。** 循环每轮只推进一步。要看到目标达成，跑足够的周期。

### 周期报告

`agent.run()` 返回 `CycleReport[]`，每次周期一条：

```ts
report.perceptsOffered;    // 提供了多少
report.perceptsAdmitted;   // 进去了多少
report.refused;            // 被拒的，带原因和显著度
report.recalled;           // 回忆到几条
report.surprise;           // 这一轮的意外值
report.focusedGoals;       // 当前聚焦的目标
report.plan;               // { goal, steps, confidence }
report.action;             // { name, succeeded }
report.expected;           // 对下一步的预测
report.reflected;          // 这轮反思了吗
```

`agent.history()` 拿全部，`agent.lastCycle()` 拿最近一条。

### 现成场景

不想自己接线的话，`src/scenarios/pipeline.ts` 是一个完整可跑的例子（`node src/cli.ts demo`），含平静/事故/修复三段，并且带**种子化的抖动** —— 所以不同种子会产出不同轨迹，这让"不同种子必须发散"的测试真正有意义。

---

## 12. 接一个大模型

`ModelAdapter` 的核心不是"怎么调用模型"，而是**怎么隔离它**。

```ts
import { ModelAdapter, type ModelClient } from 'logos-cognitive-kernel/reasoning';

// 自带传输层 —— 包本身不捆绑任何 HTTP 客户端
const client: ModelClient = {
  name: 'my-model',
  async complete(request) {
    const response = await fetch('https://api.example.com/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: request.messages }),
      signal: request.signal,
    });
    const body = await response.json();
    return { content: body.text, confidence: body.confidence, tokens: body.usage?.total };
  },
};

const adapter = new ModelAdapter({
  clock: kernel.clock, bus: kernel.bus, rng: kernel.rng,
  client,
  gate,          // 响应会过注意门控，因此可以被拒绝
  beliefs,       // 结构化字段会成为信念的证据
  calibrator,    // 模型自报的置信度会成为被打分的预测
  domain: 'diagnosis',
  timeoutMs: 30_000,
  maxRetries: 2, // 只对传输失败重试
});

await adapter.ask('what is likely wrong with the pump?');

const outcome = await adapter.askStructured('what went wrong?', {
  cause: 'string',
  severity: 'number',
  likelyCauses: 'string[]',
});
if (outcome.ok) console.log(outcome.value.cause);
else console.log(outcome.reason, outcome.raw);
```

### 四条约束，每一条都是刻意的

| 约束 | 含义 |
|---|---|
| **模型是不可信输入** | 结构化响应按声明形状校验。不合形状就**拒绝，绝不强转** —— 问数字却回了字符串 `"5"`，那是没回答问题。强转会把失败推到更晚、更远的地方。 |
| **形状失败绝不重试** | 传输失败会重试（它不说明输出质量）；形状失败不会 —— 重试等于**换个形状再问一遍同样的问题**，只会让统计数字比模型实际水平好看。 |
| **模型的置信度是"声称"** | 模型说 90% 确信时，这变成一个**交给校准器打分的预测**。一个说 90% 却只对一半的模型，会在这类任务上被**测出来**过度自信，之后 `adjustedConfidence` 自动给它打折 —— 不需要任何人手工编码这个判断。 |
| **模型永不直接行动** | 它只产出文本、声称和候选计划。对世界的每一个影响都要过技能注册表和规划器，它们有自己的前置条件和账目。 |

第三条是真正有意思的地方：校准让模型的自我置信度从**修辞**变成**可测量属性**。这几乎是没有 agent 框架能做到的事，因为几乎没有框架会在**验证之前先写下模型声称了什么**。

### 输出会被门控拒绝

`adapter.stats` 给你一堆真实数字：

```ts
adapter.stats.calls;
adapter.stats.wellFormedRate;      // 按所有调用算，不是按"成功的子集"
adapter.stats.schemaFailures;
adapter.stats.transportFailures;
adapter.stats.admitted;            // 过了门控
adapter.stats.refused;             // 被门控拒了
adapter.stats.meanStatedConfidence;
```

**结算模型的预测**，让它进入校准记录：

```ts
adapter.settleDomain('diagnosis', true);    // 只结算这个 client 在这个域的预测
```

---

## 13. 确定性、复现与调试

### 三条铁律

1. **所有随机性走 `kernel.rng`。** 有测试扫描 `src/` 禁止 `Math.random`。
2. **所有时间走 `kernel.clock`。** 不要用 `Date.now()` 做逻辑判断 —— 同一次运行里 `Date.now()` 会变，逻辑就会不确定。
3. **不要依赖 Map 的迭代顺序做决策。** 需要规范顺序的地方（比如信念重算）都显式排序了。自己写的时候也要。

### 复现一次运行

```bash
node src/cli.ts demo --seed 1234 --quiet > a.txt
node src/cli.ts demo --seed 1234 --quiet > b.txt
diff a.txt b.txt     # 应该没有任何差异
```

**id 也是确定的** —— `newGoalId()` 返回 `goal_1`、`goal_2`……而不是随机后缀。这一点曾经是 bug：id 用 `Math.random()` 生成，而 id 从不出现在演示的打印输出里，所以同种子重跑**看起来**完全一致，底下每个事件、快照、信念 payload 却都带着不同的 id。引用 id 的 bug 报告根本无法复现。

### 每个存储都能自审

```ts
working.check();      // 返回问题字符串数组，空数组 = 健康
episodic.check();
semantic.check();
beliefs.check();
goals.check();
world.check();
```

八个存储里有六个提供 `check()`。规划器不提供（它在调用之间不持有状态），校准器也不提供（它的记录是只增的分数，没有跨字段不变量可违反）。

**用 `check()` 定位问题，比读日志快得多。** 它检查的是结构不变量 —— 计数对不上、引用悬空、值越界这类。

### 内核健康

```ts
kernel.health();   // HealthReport[]
```

第一条永远是内核自己，之后是**实现了 `health()` 的**子系统。没实现的不会出现 —— 内核不会替它编一份。健康检查自己抛异常时，那个异常**本身**会作为一条 `ok: false` 的报告被记录，而不是让整个 `health()` 崩掉。

---

## 14. 命令行

```bash
node src/cli.ts tui               # 实时仪表盘 ← 最直观
node src/cli.ts demo              # 端到端认知场景
node src/cli.ts repl              # 逐行交互
node src/cli.ts inspect           # 当前组装状态
node src/cli.ts bench             # 吞吐基准
node src/cli.ts help              # 用法
```

**参数**：

| 参数 | 作用范围 | 说明 |
|---|---|---|
| `--seed <n>` | 全部命令 | 随机种子（十进制或 `0x` 前缀），决定一切 |
| `--preset <name>` | `demo` · `repl` · `inspect` | `default` \| `reflective` \| `reactive` \| `research` \| `minimal` |
| `--cycles <n>` | **仅 `bench`** | 周期数。demo 的三段长度是固定的 |
| `--quiet` | `demo` | 只输出摘要 |
| `--json` | `inspect` | 机器可读输出 |

```bash
node src/cli.ts demo --seed 1234
node src/cli.ts demo --preset research
node src/cli.ts inspect --preset minimal
node src/cli.ts inspect --json --seed 777 | jq .
node src/cli.ts bench --cycles 500
```

**两个输出契约**（都有测试保证）：

- `--json` 的 stdout **只有那个 JSON 文档**，没有横幅、没有额外日志。一个先打印问候语的 JSON 模式不是 JSON 模式 —— 下游要解析它。
- `--quiet` 缩短输出但**保留 summary 行**。

**未知的 preset 是错误，不是静默回退**：

```bash
$ node src/cli.ts demo --preset nonsense
error: unknown preset "nonsense". Available: default, reflective, reactive, research, minimal
$ echo $?
2
```

静默回退到默认是更糟的选择：一个拼写错误会产生一次"看起来正常但配置是错的"运行。

### 预设

| 预设 | 特点 |
|---|---|
| `default` | 平衡 |
| `reflective` | 更多反思、更高阈值，慢而谨慎 |
| `reactive` | 快、预算小、阈值低 |
| `research` | 大容量记忆、长半衰期、探索性强 |
| `minimal` | 最小可用配置，用于测试 |

预设只是 `config` 的值集合，可以在 `new Kernel({ config: { ... } })` 里逐项覆盖。

实测的差别（同一场景，只换预设）：

| 预设 | working memory | demo 结果 |
|---|---|---|
| `minimal` | 4 槽 | 4 episodes, 4 beliefs |
| `default` | 7 槽 | 6 episodes, 6 beliefs |
| `research` | 12 槽 | 6 episodes, 6 beliefs |

### 交互模式（`repl`）

```bash
node src/cli.ts repl
```

```
logos> the primary database has stopped accepting writes
  admitted 1/1, surprise 0.00, recalled 2, acted: observe the situation
```

敲一行观察，智能体走一个完整认知周期，然后告诉你这一轮发生了什么。

**`admitted` 可能小于 `perceptsOffered` —— 你的输入被门控拒了。** 这在两种情况下是正确的：

- **你说的话既新颖又在意料之中**（新颖度低、意外度低）：心智有理由忽略它
- **同样的东西你刚说过**：习惯化生效了，一个一直在响的警报会被忽略

如果输入进不去，让它更容易进来的办法：

| 办法 | 为什么有效 |
|---|---|
| 换 `--preset reactive` | 阈值更低 |
| 先喂几轮，让世界模型建立转移 | 之后违背预期的输入才有 `surprise` 可拿，而 surprise 是权重最高的一项（0.35） |
| 说得更出乎意料 | `the datacentre is on fire` 比 `the database is slow` 显著得多 |

REPL 命令：`:state` `:beliefs` `:goals` `:memory` `:quit`

> **一段值得知道的历史。** 这个模式曾经**任何输入都进不去**。门控权重里新颖度占 0.25，而默认阈值是 0.35 —— 一个"最大新颖度"的观察最高只能得 0.35 分，还必须 `intensity` 拉满才够。REPL 用 0.8，得 0.33，**每一条输入都被静默拒绝**，敲一天也看不到任何反应。
>
> 更糟的是，这等于门控在拒绝**它存在的理由**：完全出乎意料的事本该抓住注意力。
>
> 没有任何测试发现它，因为**所有门控测试都显式传了 `threshold`**，没有一个用默认配置 —— 阈值和分布必须成对检查，单独看每一个都合理。
>
> 现在阈值是 0.28，并且 `test/gate-defaults.test.ts` 专门用**出厂默认**测试这件事，包括"新颖的安静输入仍被拒"和"熟悉的输入仍被拒"两个反向断言。

### 可视化界面（`tui`）

```bash
logos tui
```

一个**实时仪表盘**：注意力、工作记忆、目标、世界模型、信念和校准，全部按 8Hz 刷新，底部有输入行。

```
┌ attention ────────────────────────┐┌ goals & action ────────────────────┐
│ agent[tick=6 cycles=6 wm=1/7 ...] ││ active    p=0.50 understand what...│
│                                   ││                                    │
│ ADMITTED                          ││ PLAN                               │
│   ▸ the primary database has ...  ││   understand what is happening     │
│                                   ││   1 steps @ 0.76                   │
│ REFUSED (why a mind can ignore)   ││ ACTED observe the situation ✓      │
│   ▸ heartbeat ok      habituated  ││                                    │
└───────────────────────────────────┘└────────────────────────────────────┘
┌ working memory ───────────────────┐┌ world model ───────────────────────┐
│ 6/7 slots  pressure 0.86          ││ states 8  transitions 10  obs 15   │
│   ████████░░░░ 0.82 the primary…  ││ surprise ████████░░░░ 0.68         │
└───────────────────────────────────┘└────────────────────────────────────┘
┌ beliefs, calibration, memory ───────────────────────────────────────────┐
│ beliefs 6  episodes 6 · concepts 1 · skills 3                           │
│ calibration uninformative  n=43 brier=0.444 bias=+0.035 skill=-0.86     │
└─────────────────────────────────────────────────────────────────────────┘
› type an observation here
```

**输入一行观察，它走一个完整认知周期。** 底部会立刻告诉你发生了什么：

| 提示 | 含义 |
|---|---|
| `admitted · surprise 0.87 · recalled 6` | 进去了，而且很意外 |
| `refused (habituated)` | 同样的东西刚说过，它忽略了 |
| `refused (below-threshold)` | 不够新颖也不够意外 |

面板里的命令（输入后回车）：

`:state` `:beliefs` `:goals` `:memory` `:world` `:skills` `:clear` `:help` `:quit`

**为什么没有网页界面？** 这是刻意的。一个 React 前端意味着构建步骤、依赖树和供应链审计 —— 在一个**核心主张是零依赖**的仓库里。Node 自带画仪表盘需要的一切（raw mode、ANSI、HTTP 服务器），所以界面可以完整，而 `package.json` 一行不加。

**它需要真终端。** 输出被重定向到管道或文件时会直接报错退出，因为一个重定向的仪表盘就是一个装满光标移动指令的文件 —— 而做这件事的人其实想要 `inspect` 或 `demo`。

**退出时一定恢复光标和颜色**，否则你的 shell 会继承它们。这条有测试钉住：用 `:quit` 退出曾经留下隐藏的光标，因为 `closed` 标志被同时用来表示"停止绘制"和"已经清理完毕"。

### 装成全局命令（可选）

想在任意目录直接敲 `logos`：

```bash
cd <项目目录>
npm link
```

之后：

```bash
cd ~
logos demo --seed 1234
logos bench --cycles 500
logos inspect --preset research
```

`npm link` 会在全局 npm 目录建一个软链接指回这个项目 —— **改了源码立刻生效，不用重新 link**。卸载用 `npm unlink -g logos-cognitive-kernel`。

---

## 15. 常见陷阱

按踩到频率排序，全部是真实踩过的。

### ① `npm install` 说 "up to date" 但什么都没装

你的 npm 配置里有 `omit=dev`。用 `npm install --include=dev`。

### ② Node 版本不够

报 `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"` 就是版本问题。需要 **≥ 22.18.0**。

### ③ `addEvidence(...).id` 不是证据 id

`addEvidence` 返回 `Belief`，`.id` 是**命题**的 id。证据 id 在 `belief.evidence[i].id`。传错现在会抛错，早先会静默失效。

### ④ `working.get()` 默认会强化

写探针、做只读检查时用 `working.get(id, { reinforce: false })`。否则你的观测行为本身在改变被观测对象。

### ⑤ 智能体没有过去

`agent.run(n)` 不给感知源，就什么都不会被录取，`episodic.size` 一直是 0，巩固引擎没有原料。

用 `agent.run(n, () => [percept, ...])` 喂输入。

### ⑥ REPL 里输入被拒绝

显示 `admitted 0/1`，什么都没发生。**通常这是正确行为**：那句话既不够新颖也不够意外，或者同样的东西刚说过（习惯化）。

想让它进去：换 `--preset reactive`、先喂几轮建立世界模型转移、或者说得更出乎意料。

**但如果你发现无论说什么都进不去**，那是 bug 不是特性 —— 这个模式曾经真的有过（阈值 0.35 vs 新颖度上限 0.35），修在 `test/gate-defaults.test.ts` 里。

### ⑦ CLI 的 `--cycles` 对 demo 无效

`--cycles` **只对 `bench` 生效**。demo 的三段（平静 / 事故 / 修复）长度是固定的，因为要观察的正是**阶段之间的转变**。

`demo` 44 个周期、`bench` 可配 —— 这是设计不是遗漏。

### ⑧ 忘了 `gate.setPredictor(world)`

不设的话 `surprise` 项退化为中性值，门控失去了最重要的信号。

### ⑨ 自己 new 时钟

所有层必须共享同一个 `Kernel` 的 `clock`。分开的时钟会让记忆衰减和调度器脱节，而且现象很隐蔽 —— 记忆就是"莫名其妙不衰减"或"莫名其妙忘光了"。

### ⑩ 期望一个周期完成一个目标

每个周期推进一步。跑够周期数。

### ⑪ 用情景记忆当审计日志

每次检索都会**改写**它（再巩固）。要不可变的记录，用事件总线。

### ⑫ `Method` 同时给了 `subtasks` 和 `actions`

二选一。给两个会抛错。

### ⑬ 在 `src/` 里 import 了非相对路径

CI 和元测试都会拦。所有 import 必须是相对路径或 `node:` 内置模块。

### ⑭ 用了 `enum` / `namespace` / 参数属性

Node 的类型擦除不能处理它们（它们会生成运行时代码）。`tsconfig` 里开了 `erasableSyntaxOnly`，类型检查会拦住。

---

## 16. 扩展与贡献

### 加一个新的子系统

```ts
import type { Subsystem, HealthReport } from 'logos-cognitive-kernel/kernel';

const mySubsystem: Subsystem = {
  name: 'my-subsystem',
  start(context) {
    context.bus.on('kernel:tick', () => { /* ... */ });
  },
  stop() { /* 清理 */ },
  health(): HealthReport {
    return { subsystem: 'my-subsystem', phase: 'running', ok: true, detail: '', metrics: {} };
  },
};

kernel.use(mySubsystem);
```

**跨层通信只能走总线。** 直接持有另一个层的实例会让依赖图失控，而且会绕过事件记录 —— 调试时你会失去唯一的全局时间线。

### 加一个新的技能动作

`SkillContext.act(name, params)` 是唯一的动作出口。在环境里实现它：

```ts
const environment: Environment = {
  observe: () => ({ cacheCold: true, pool: 'small' }),
  act: (name, params) => {
    switch (name) {
      case 'stop':  return true;
      case 'start': return true;
      default:      return false;   // 未实现的动作返回 false = 执行失败
    }
  },
};
```

注意：技能步骤里的 `action` 名字要和你 `act` 里处理的名字对上，对不上会记成 `execution-failed`（这**会**影响掌握度）—— 所以名字打错会被误当成"不擅长"。用 `skills.check()` 能查出引用不存在动作的技能。

### 贡献流程

见 [CONTRIBUTING.md](../CONTRIBUTING.md)。要旨：

- **测试是论点，不是文书。** 新行为必须带能说明"这条主张为什么成立"的测试。
- **文档里的主张要可检验。** 现在有 25 个元测试在检查项目对自己的陈述（版本号一致、分层声明齐全、零依赖、容器非 root、CI 仍然强制确定性）。
- **修 bug 时先写会失败的测试。** 这个项目有 6 个缺陷是靠"没人验证的主张"活下来的，它们的共同点是：**看起来对**。
- 提交信息要写**为什么**、**什么缺陷促成了它**、**否掉了哪些替代方案**。

---

## 17. API 速查

### 内核

```ts
const kernel = new Kernel({ config, clock, bus, scheduler });
await kernel.start();  await kernel.stop();  await kernel.tick();
kernel.use(subsystem);
kernel.describe();  kernel.health();  kernel.snapshot();
kernel.emit(type, payload);
kernel.clock.advance(n);  kernel.clock.current;
kernel.bus.on(pattern, handler);  kernel.bus.publish(type, payload, tick);
kernel.scheduler.enqueue(task);  kernel.scheduler.getState(id);
kernel.rng.next();  kernel.rng.int(min, max);  kernel.rng.pick(array);
```

`bus.on()` 支持通配符：`kernel.bus.on('memory:*', ...)`。

### 记忆

```ts
working.encode(content, { salience, confidence, data });
working.get(id, { reinforce });  working.contents();  working.focused();
working.prime(text, weight);     working.step();      working.advance(n);
working.check();  working.clear();

episodic.encode(content, { situation, context, surprise, selfRelevance, affect, data });
episodic.recall({ text, limit, ... });   episodic.retrieve(id, { context });
episodic.get(id);  episodic.size;  episodic.advance(n);  episodic.stats();

semantic.observe({ label, definition, aliases, categories, properties, sourceEpisode, sourceEpisodes });
semantic.get(label);  semantic.all();  semantic.find(query);  semantic.spread(...);
semantic.property(label, key);  semantic.relate(...);  semantic.check();

new ConsolidationEngine({ clock, bus, scheduler, config, rng, episodic, semantic });
engine.consolidateNow();

new Rememberer({ working, episodic, semantic, rng, now });
rememberer.recall({ text, limit, stores, mood, spreadDepth });
```

### 注意

```ts
new PerceptionGate({ clock, bus, config, rng, working, threshold, ... });
gate.perceive(input);      // { admitted, reason, percept }
gate.perceiveAll(inputs);
gate.score(input);         // 只看分，不入记忆
gate.setPredictor(world);
gate.step();               // 推进习惯化
gate.dishabituate(content, source);
gate.snapshot();  gate.reset();
```

`PerceptInput`：`{ content, modality, source, intensity?, affect?, data? }`
`modality`：`'text' | 'numeric' | 'event' | 'internal' | 'social' | 'symbolic'`

### 推理

```ts
new WorldModel({ clock, bus, rng, matchThreshold, maxStates, smoothing, surpriseThreshold });
world.observe({ content, source });   world.expect(state, successorLimit);
world.predict(steps);                 world.surpriseOf(percept);
world.currentState();  world.knownStates(limit);  world.stats();  world.check();

new BeliefStore({ clock, bus, ... });
beliefs.declare(prop, { prior, data });
beliefs.addEvidence(prop, { content, source, stance, strength, reliability, id, data });   // 返回 Belief
beliefs.retract(prop, evidenceId);     // evidenceId 来自 belief.evidence[i].id
beliefs.setPrior(prop, prior);   beliefs.link(a, b, { kind, weight });   beliefs.propagate();
beliefs.get(prop);  beliefs.all();  beliefs.query(...);  beliefs.asserts/denies/isUndecided;
beliefs.check();  beliefs.clear();

new ModelAdapter({ clock, bus, rng, client, gate, beliefs, calibrator, domain, timeoutMs, maxRetries });
await adapter.ask(prompt, { system, domain, intensity, bypassGate });
await adapter.askStructured(prompt, schema, { system, domain, intensity });
adapter.settle(id, wasCorrect);  adapter.settleDomain(domain, wasCorrect);
adapter.stats;  adapter.history;  adapter.describe();
```

### 规划

```ts
new GoalSystem({ clock, bus, beliefs, ... });
goals.declare(description, { parent, utility, deadline, notBefore, requires, conflictsWith, composition, feasibility, data });
goals.get(id);  goals.all();  goals.byStatus(...);  goals.childrenOf(id);  goals.ancestry(id);
goals.achieve(id, note);  goals.fail(id, reason);  goals.abandon(id, reason);
goals.activate(id);  goals.suspend(id, reason);
goals.setFeasibility(id, value);  goals.chargeCost(id, cost);  goals.noteProgress(id);
goals.stats();  goals.check();

new Planner({ clock, bus, ... });
planner.defineAction({ name, description, preconditions, effects, cost, reliability, execute });
planner.defineMethod({ name, task, preconditions, priority, confidence, subtasks, actions });
planner.plan(task, state);   // { ok: true, plan } | { ok: false, failure }
planner.action(name);  planner.methodsFor(task);  planner.knownTasks();
```

### 元认知

```ts
new Calibrator({ clock, bus, minimumSamples, ... });
calibrator.predict(claim, confidence, { domain, source });
calibrator.resolve(id, wasCorrect);   calibrator.resolveWhere(predicate, wasCorrect);
calibrator.report(domain?);           // { resolved, bias, brier, reliability, resolution, skill, verdict }
calibrator.reportAll();               // 每个域一份
calibrator.adjustedConfidence(p, domain?);
calibrator.observedFrequency(p, domain?);
calibrator.pendingCount;  calibrator.resolvedCount;  calibrator.domains;  calibrator.pendingConfidence;
calibrator.forget(id);    calibrator.clear();

new SelfModel({ clock, bus, calibrator, evidenceThreshold, attentionScale, capacity });
self.observe({ strategy, kind, succeeded, confidence, attention, startedAt, detail });
self.recommend({ kind, description, stakes, familiarity }, { available });
self.adjustConfidence(confidence, kind);
self.records(kind?);  self.record(strategy, kind);  self.kinds;  self.journal;  self.decisions;
self.check();  self.clear();
```

### 技能

```ts
new SkillRegistry({ clock, bus, rng, scheduler, competentAbove, confidenceAfter, ... });
skills.define({ name, achieves, description, steps, preconditions, prior, tags });
await skills.attempt(name, { act, state, budget }, { interruptible });
skills.get(id);  skills.byName(name);  skills.all();  skills.forGoal(achieves, limit);
skills.isCompetent(name);  skills.costOf(name);  skills.stats;
skills.forget(name);  skills.check();  skills.clear();
```

`SkillStep`：

```ts
{ kind: 'action', name, params? }
{ kind: 'skill', name }
{ kind: 'branch', on, then, otherwise? }
{ kind: 'repeat', times, body }
```

### 智能体

```ts
new CognitiveAgent({ kernel, working, episodic, semantic, consolidation, rememberer,
                     gate, world, beliefs, goals, planner, calibrator,
                     environment?, reflectEvery?, actAbove? });
await agent.cycle(percepts);   await agent.run(cycles, perceptSource?);
agent.lastCycle();  agent.history();  agent.state();  agent.describe();
agent.cycles;  agent.reflections;
```

### 顶层

```ts
import { VERSION, LAYERS } from 'logos-cognitive-kernel';
// LAYERS: 每层的 { level, name, purpose }
```

---

## 遇到问题

1. `npm run verify` —— 三者全过说明环境没问题
2. `store.check()` —— 结构问题最快的定位方式
3. `kernel.health()` —— 子系统层面的问题
4. 加 `--json` 看机器可读状态
5. 还不行就带上 `--seed` 和最短复现开 issue

**关于范围的一句实话**：这个项目不是一个 AGI，也没有人做出来过。它是一个认知**内核** —— 分层记忆、稀缺注意力、可修正信念、分层规划、程序性记忆和自我模型。它没有持久化（进程结束状态就没了），没有安全审计，1.0 之前 API 会变。[ARCHITECTURE.md](./ARCHITECTURE.md) 里有更完整的、按模块列的局限说明。
