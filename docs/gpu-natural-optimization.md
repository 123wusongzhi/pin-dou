# GPU 自然取样与低预算比较

## 已接入

在“电脑GPU高质量”通道中，先选择处理模式“轮廓增强”，再选择“自然平衡”。
新字段 `settings.gpuSampling` 为 `natural | detail`，缺失时仍走原 `detail`。
其他处理模式以及浏览器标准通道保持原有行为。

自然取样先计算每格线性光平均色，以它约束亮度；在浅色低色度区域降低细节加权造成的暗化。
其他区域有限混入有实际面积支持的源色代表，避免全图加亮或锐化。
透明度独立计算，不从隐藏的透明RGB取色。

量化仍使用已部署的 `mard-optimized-v2`，保留低色度异常增艳保护。
生成信息另外记录 `natural-v1 / detail-v1 / dominant-v1 / average-v1` 采样版本。
作品、撤销/重做和备份保存该信息。

## 验证边界

本轮测试7图、52/65/78格、8/12/16/20色、两种取样与两种量化目标，共336组。
图纸实际调用生产后处理并匹配真实MARD色号；比较算法时固定格数、颜色上限、裁切与背景。
跨尺寸则统一重建到512像素，与同一原图参照比较，避免小尺寸参考更模糊而虚假获益。

六张同角色插画在65格16色下，自然取样的浅色区域暗化减轻，平均亮度和梯度误差改善。
但不是每项细节都改善：52格的部分红领带变成灰褐，个别图的孤立格增加。
重要性加权量化虽然照顾小面积彩色，也出现领带过艳，因此没有加入生产默认。

每格只能放一种实物豆色。格数、颜色、保真不能同时各自取极值。
应先检查角色、姿态、眼睛、饰物和关键颜色，再从可接受候选中比较实际豆数、颜色数。
“模型偏好”“色差降低”“用料减少”是不同证据，不合成为未经校准的保真百分比。

## Jev 可选决策工具

`scripts/judge-pindou.mjs` 使用 OpenRouter Decisions API 的 `typesafe/jev-1.14`。
它比较原图与A/B候选，不生成图片，也不修改图纸。
环境变量使用 `OPENROUTER_API_KEY`，兼容本机 `openrouter`；密钥只在执行进程读取。

任务JSON包含1–3个候选对：

```json
{
  "stopAfterCostUsd": 0.01,
  "pairs": [{
    "id": "same-budget",
    "reference": "E:/example/original-512.png",
    "features": "hat silhouette, monocle, blue eyes, red necktie",
    "A": { "id": "candidate-a", "path": "E:/example/a-512.png" },
    "B": { "id": "candidate-b", "path": "E:/example/b-512.png" }
  }]
}
```

先预检，不发送请求：

```powershell
node scripts/judge-pindou.mjs --job pairs.json --out results.json
```

明确运行外部图片评审：

```powershell
node scripts/judge-pindou.mjs --job pairs.json --out results.json --live
```

每对正反两个顺序，最多六次；固定提供方、禁止fallback，无自动重试。
已存在的结果文件不会覆盖，避免意外重复付费。
候选使用512×512最近邻PNG，原图与候选保持相同几何范围，模型看不到算法名、格数和费用。
完整预览会按此操作上传到OpenRouter/TypeSafe。

费用停止线依据已返回费用，在达到阈值后停止后续调用；进行中的单次请求仍可能超过它，不是供应商硬预算。
超时或无法确认计费时标记 `billingIncomplete`，已知usage独立于答案校验保存。
日志只保留图片hash、候选映射、答案和计费，不保存密钥、base64或供应商错误正文。

本轮六次均成功，实际返回费用合计 `$0.000769986`。
三对交换顺序后胜者一致，但概率会变化，52格可接受概率甚至跨过0.5。
所以工具保留 `unknown` 和概率值，不自动批准图纸或认证最小尺寸。
网页上选择自然平衡不会触发此工具或产生OpenRouter费用。

## 同预算 Jev 增量实验（2026-10-20）

后续另做了六次真实请求，专门检验视觉决策是否比固定算法选择带来增量：

- BAS-01固定65×65、实际16色、3510非空格；BOY-01固定65×65、实际12色、4225非空格。
- 每组包含原始natural-v2基线，以及两个CUDA单色板槽位替换候选。所有候选使用相同取样、实体色库、透明范围和生产后处理；没有增大网格或颜色预算。
- 用人工指定的关键区域作为本次实验的配色目标，不能推广为已经实现自动语义识别。
- 在请求之前冻结候选与确定性评分的赢家，再用三候选循环换位评审。
- 另设字节完全相同图片控制和保持颜色直方图的空间打乱控制。两者均通过。

结果：BAS两次分别选择两个不同的优化候选；BOY两次都判tie。按照预先固定的“两次同赢家且概率差值≥0.10”的规则，最终均回退原始基线。**Jev没有直接选择基线；这是执行器对不一致或无法唯一选择的回退。**

BAS算法候选恢复了领带暗红色，领带区域平均ΔE由18.69降至10.62；但这个改进来自候选生成，固定算法已能选择到它。BOY候选改善肤色和五官区域的色差，同时增加衣服误差和孤立格（292→338）。本次没有证明Jev相对固定选法有稳定的额外质量收益，因此没有将它加入网页默认链路。

六次调用全部成功，费用 `$0.00122346`，请求计时合计5.449秒。仅两个输入、两种排列，且目视评审来自Codex，不能用来估计人类一致率或证明所有任务都无效。

三候选脚本 `scripts/judge-pindou-candidates.mjs` 复用既有环境变量。默认dry-run，最多六请求，禁止重试，输出文件独占创建，费用停止规则与前述工具相同：

```powershell
node scripts/judge-pindou-candidates.mjs --job output/gpu-jev-increment/jev-job.json --out new-results.json
```

加 `--live` 才会再次付费调用；已有实验无需重跑。源码中的`decisionId`保存供应商ID，`id`保留逻辑请求名。本次历史结果产生于该命名修正之前，调用ID被供应商ID覆盖；原始记录未改，仍可通过control或group/order及图片hash无歧义匹配。

报告、实际结果图、局部放大、改色格位置与用料都在 `output/gpu-jev-increment/`：

- `comparisons/report.html`：全部候选、原始模型选择及回退后的实际成图。
- `candidates/recipe.json`、`selection.json`：预先固定的生成方式和算法选择。
- `jev-results.json`、`jev-review.md`：完整返回、费用和独立复核。
- `visual-precheck.md`：调用前Codex目视观察。

## 35 色、严格局部决策实验（2026-10-20）

用户随后要求固定关键区域外的格子，只对局部方案做判断，并将颜色数设为35。
结果保存在 `output/gpu-jev-local35/`，报告为 `comparisons/report.html`。

两张输入都重新生成实际35色的65×65自然GPU基线。四个独立任务是基德眼睛/单片镜、基德领带、男孩眼睛、男孩嘴部；每个任务有基线、局部线性均值配色、局部原图代表色配色三个候选。全部候选严格使用各自基线已有的同一套35色，区域外和alpha逐格变化均为0，局部改动2–45格。没有重新全图合色，四组不是串行叠加修改。

候选区域来自人工指定的原图坐标。它们与两类候选、评分权重及算法赢家均在Jev调用之前冻结。固定算法四组均选线性均值候选；这是色差与亮度代理分的胜出，不保证主观最好。Codex调用前目视认为男孩嘴部代表色候选的牙齿更清楚，但颊部更块状。

本轮`job.protocolVersion="local35-v1"`使脚本明确只询问单个局部，并使用全图+单ROI放大图。四组各两种循环顺序，加相同图与局部亮暗交换控制，共最多10次、无重试，已知费用停止线仍为$0.01。旧双图实验仍限定六请求。

十次全部成功，两控制按预定答案通过；但局部劣化控制中完整图的概率仅0.46，不能把控制通过理解为视觉能力很强。八次正常比较全部返回tie，四组按预设规则保留35色基线。本轮没有得到可采用的Jev局部改格，也没有把只在候选选项中最高、却低于tie的分数事后当成赢家。

实际费用 `$0.00238077`；输入56,685 / 输出1,022 tokens；请求计时合计8.075秒。模型返回版本为`typesafe/jev-1.14-20261014`。所有候选、原始答案、变更位置、同色数验证和联合输出均可在报告追溯。

边界：本实验只允许在已经选定的35色中重新配色，没有允许替换色板中的色号；部分候选仅差2或5格，三个候选里两个近似也可能导致无唯一赢家。它不能证明Jev对所有局部任务都无效，更不能把从16/12色增加到35色的画质变化归功于Jev。生产网页没有新增付费调用或默认行为。

## 研究来源

- [DPID](https://github.com/mergian/dpid)：按局部差异保细节，本项目没有声称完整复现论文。
- [Kopf等：Content-Adaptive Image Downscaling](https://johanneskopf.de/publications/downscaling/)：形状和采样位置值得联合考虑。
- [Gerstner：Pixelated Image Abstraction](https://cragl.cs.gmu.edu/pixelate/journal.html)：低格数、少色盘和重要性约束。未复制GPL实现。
- [Pixelating Vector Line Art](https://diglib.eg.org/items/3468d785-2fb6-498f-8947-e1fc587f6675)：低分辨率轮廓、线条连续性。
- [SD-πXL官方实现](https://github.com/AlexandreBinninger/SD-piXL)：固定尺寸与离散色盘优化；完整生成式优化未引入交互通道。
- [量化质量评估研究](https://arxiv.org/html/2011.12652v1)：多个代理指标需与实际视觉观察核对。
- [OpenRouter多模态决策](https://openrouter.ai/docs/guides/community/multimodal-decisions)、[TypeSafe图像功能边界](https://docs.typesafe.ai/images)。
