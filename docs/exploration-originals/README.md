# 基准图归档说明（已过期，勿当视觉真相）

本目录是 **2026-08-20** 抓取的原版界面截图归档（29 张 PNG + 1 HTML/MHTML/PDF 存档）。
它们比当前代码早约 6 周，属于**上一代设计**。

---

## ① 拍摄日期

- 全部素材的文件 mtime 落在 **2026-08-20 16:41–17:28**（+0800），无一例外。
- 随目录在 commit `6a13be3`（2026-09-27「整理：项目目录清理 + 完整文档」）入库。
  mtime 早于入库日期，说明这批图是 8-20 当天拍、9-27 才归档的，不是重新导出的。

## ② 对应哪一代设计

**上一代**。三条可复核的对照（截图所见 → 当前代码）：

| 对照点 | 截图所见 | 当前代码 |
| --- | --- | --- |
| 主题切换 | `hifin-setting-preference.png`：**单个开关**，副标题「切换纯白或暗黑模式」 | `PreferencesSection.tsx:33-37,74-101`：**三选一 radiogroup**（浅色 / 暗黑 / 跟随系统），`role="radiogroup"` + `role="radio"` |
| Switch 配色 | 同图：开关轨道为**绿色**（实测像素 ≈ `rgb(9,93,66)`，剥掉遮罩还原 ≈ `#12ba84`，emerald 系） | `Switch.tsx:41`：`checked ? 'bg-brand' : 'bg-border dark:bg-border-dark'`，即品牌靛蓝 `#6366f1`（2026-10-04 `a3ef10a` 改为品牌色，不再是绿/单色黑） |
| 分类表头 | `hifin-categories.png`：两列都叫「分类数量」 | `CategoriesSection.tsx:111-112`：「分类数量」+「分组数量」 |

一句话：**截图那一代 = 单开关主题 + 绿色 Switch；当前代码 = 三选一主题 + 品牌靛蓝组件。**

> 补充：`docs/design-review.md` §3.6 把当前的 Switch 描述为「单色（`bg-text` / `bg-border`）」，
> 那是 `a3ef10a` 之前的写法；现在开启态是 `bg-brand` 靛蓝。「截图绿 / 现在非绿」这个对照点不受影响。

## ③ 勿当作当前视觉真相

> **这批图已过期。任何视觉判断以代码为准，不以本目录为准——包括未来任何一次审查。**

自 2026-08-20 起，代码侧已发生 `design-fix(1/3)(2/3)(3/3)`、首屏代码分割、
色彩语义轴迁移、分类色暗色对比度修复（`bcb3a54`）等改动；本目录的图**一张都没有更新过**。
拿它做像素比对、对色、判「回退」都会得到错误结论。

## ④ 暗色模式零基准图

**本目录不存在任何暗色模式截图。** 29 张 PNG 全部是浅色模式。

其中 8 张（`hifin-settings.png`、`hifin-cmdk.png`、`hifin-categories.png`、
`hifin-setting-*.png` 共 5 张）平均亮度偏低，**但那不是暗色模式**——是浅色页面上罩了一层
模态遮罩（scrim）。用亮度直方图可区分：

| 样本 | 极暗像素占比（亮度 < 40） |
| --- | --- |
| 本目录 8 张「偏暗」图 | 0.3% – 0.4% |
| 真正暗色模式截图（`accept/screenshots/darkmode-audit/`） | 93.6% – 98.1% |

即：这些图的**底层仍是浅色页面**，只是整体被压暗约一半。真正的暗色模式在本目录**完全未验证**。

需要现构建的暗色基准图，请看 `accept/screenshots/darkmode-audit/`（18 张，
由 `accept/scripts/darkmode-audit.mjs` 于 2026-10-04 生成，已校验 `html.dark` 生效），
不要用本目录的图代替。

---

## 复现上述判断

```bash
# ① 拍摄日期
stat -c '%y %n' docs/exploration-originals/*        # 全部 2026-08-20

# ② 对照点：读当前实现
grep -n "THEME_OPTIONS\|radiogroup" app/src/features/settings/sections/PreferencesSection.tsx
grep -n "checked ?" app/src/components/ui/Switch.tsx
grep -n "brand:" -A3 app/tailwind.config.js
```

结论同 `docs/design-review.md` §3.6 与 `docs/minimax-backlog.md` T6。
若要重拍基准图：按当前构建重新截图，并**同时补齐暗色模式**，然后更新本文件的日期与代次描述。
